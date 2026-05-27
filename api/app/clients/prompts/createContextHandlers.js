const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { generateShortLivedToken } = require('@librechat/api');

const footer = `Use the context as your learned knowledge to better answer the user.

In your response, remember to follow these guidelines:
- If you don't know the answer, simply say that you don't know.
- If you are unsure how to answer, ask for clarification.
- Avoid mentioning that you obtained the information from the context.
`;

function createContextHandlers(req, userMessageContent) {
  if (!process.env.RAG_API_URL) {
    return;
  }

  const queryPromises = [];
  const processedFiles = [];
  const processedIds = new Set();
  const jwtToken = generateShortLivedToken(req.user.id);
  const headers = { Authorization: `Bearer ${jwtToken}` };
  // Documents at or under this page count are fed to the model in full (no
  // querying); larger documents use top-K semantic retrieval. The page count
  // comes from our custom RAG API (GET /documents/{id}/pages).
  const fullContextMaxPages = parseInt(process.env.RAG_FULL_CONTEXT_MAX_PAGES || '30', 10);

  /** Page count for a file; Infinity on failure so we fall back to retrieval. */
  const getPageCount = async (file) => {
    try {
      const { data } = await axios.get(
        `${process.env.RAG_API_URL}/documents/${file.file_id}/pages`,
        { headers },
      );
      return data?.pages ?? Infinity;
    } catch (error) {
      logger.warn(
        `[createContextHandlers] Could not fetch page count for ${file.filename}, using retrieval:`,
        error?.message,
      );
      return Infinity;
    }
  };

  const query = async (file) => {
    const pages = await getPageCount(file);
    if (pages <= fullContextMaxPages) {
      return axios.get(`${process.env.RAG_API_URL}/documents/${file.file_id}/context`, {
        headers,
      });
    }

    return axios.post(
      `${process.env.RAG_API_URL}/query`,
      {
        file_id: file.file_id,
        query: userMessageContent,
        k: 4,
      },
      {
        headers: { ...headers, 'Content-Type': 'application/json' },
      },
    );
  };

  const processFile = async (file) => {
    if (file.embedded && !processedIds.has(file.file_id)) {
      try {
        const promise = query(file);
        queryPromises.push(promise);
        processedFiles.push(file);
        processedIds.add(file.file_id);
      } catch (error) {
        logger.error(`Error processing file ${file.filename}:`, error);
      }
    }
  };

  const createContext = async () => {
    try {
      if (!queryPromises.length || !processedFiles.length) {
        return '';
      }

      const oneFile = processedFiles.length === 1;
      const header = `The user has attached ${oneFile ? 'a' : processedFiles.length} file${
        !oneFile ? 's' : ''
      } to the conversation:`;

      const files = `${
        oneFile
          ? ''
          : `
      <files>`
      }${processedFiles
        .map(
          (file) => `
              <file>
                <filename>${file.filename}</filename>
                <type>${file.type}</type>
              </file>`,
        )
        .join('')}${
        oneFile
          ? ''
          : `
        </files>`
      }`;

      const resolvedQueries = await Promise.all(queryPromises);

      const context =
        resolvedQueries.length === 0
          ? '\n\tThe semantic search did not return any results.'
          : resolvedQueries
              .map((queryResult, index) => {
                const file = processedFiles[index];
                let contextItems = queryResult.data;

                const generateContext = (currentContext) =>
                  `
          <file>
            <filename>${file.filename}</filename>
            <context>${currentContext}
            </context>
          </file>`;

                // Full-context responses are a plain string; retrieval
                // responses are an array of [doc, distance] pairs.
                if (typeof contextItems === 'string') {
                  return generateContext(`\n${contextItems}`);
                }

                contextItems = queryResult.data
                  .map((item) => {
                    const pageContent = item[0].page_content;
                    return `
            <contextItem>
              <![CDATA[${pageContent?.trim()}]]>
            </contextItem>`;
                  })
                  .join('');

                return generateContext(contextItems);
              })
              .join('');

      // A conversation can mix short (full-text) and long (retrieved) files,
      // so use one neutral wrapper. Small files contribute their full text;
      // large files contribute the most relevant retrieved sections.
      const prompt = `${header}
        ${files}

        Context from the attached file(s) is provided inside <context></context> XML tags. For larger files this is the most relevant retrieved sections; for smaller files it is the full document.

        <context>${context}
        </context>

        ${footer}`;

      return prompt;
    } catch (error) {
      logger.error('Error creating context:', error);
      throw error;
    }
  };

  return {
    processFile,
    createContext,
  };
}

module.exports = createContextHandlers;
