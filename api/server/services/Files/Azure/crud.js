const fs = require('fs');
const path = require('path');
const mime = require('mime');
const fetch = require('node-fetch');
const { logger } = require('@librechat/data-schemas');
const { getAzureContainerClient } = require('@librechat/api');

const defaultBasePath = 'images';
const { AZURE_STORAGE_PUBLIC_ACCESS = 'true', AZURE_CONTAINER_NAME = 'files' } = process.env;

// Default SAS token expiry: 1 hour (in seconds)
let azureSasExpirySeconds = 60 * 60;
if (process.env.AZURE_SAS_EXPIRY_SECONDS !== undefined) {
  const parsed = parseInt(process.env.AZURE_SAS_EXPIRY_SECONDS, 10);
  if (!isNaN(parsed) && parsed > 0) {
    azureSasExpirySeconds = Math.min(parsed, 7 * 24 * 60 * 60); // Max 7 days
  }
}

/**
 * Generates a SAS URL for an Azure blob
 * @param {string} blobPath - The blob path (e.g., "images/userId/fileName")
 * @param {string} [containerName] - The Azure Blob container name
 * @returns {Promise<string>} The blob URL with SAS token
 */
async function generateAzureSasUrl(blobPath, containerName) {
  try {
    const { BlobSASPermissions, generateBlobSASQueryParameters, StorageSharedKeyCredential } =
      await import('@azure/storage-blob');

    const containerClient = await getAzureContainerClient(containerName || AZURE_CONTAINER_NAME);
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

    // Get account name and key from connection string or environment
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      // If using Managed Identity, we can't generate SAS tokens directly
      // Return the raw URL and rely on public access or other auth mechanisms
      logger.warn('[generateAzureSasUrl] No connection string available, returning raw URL');
      return blockBlobClient.url;
    }

    // Parse connection string to get account name and key
    const accountNameMatch = connectionString.match(/AccountName=([^;]+)/);
    const accountKeyMatch = connectionString.match(/AccountKey=([^;]+)/);

    if (!accountNameMatch || !accountKeyMatch) {
      logger.warn('[generateAzureSasUrl] Could not parse credentials from connection string');
      return blockBlobClient.url;
    }

    const accountName = accountNameMatch[1];
    const accountKey = accountKeyMatch[1];
    const sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);

    const startsOn = new Date();
    const expiresOn = new Date(startsOn.getTime() + azureSasExpirySeconds * 1000);

    const sasToken = generateBlobSASQueryParameters(
      {
        containerName: containerName || AZURE_CONTAINER_NAME,
        blobName: blobPath,
        permissions: BlobSASPermissions.parse('r'), // Read only
        startsOn,
        expiresOn,
      },
      sharedKeyCredential,
    ).toString();

    return `${blockBlobClient.url}?${sasToken}`;
  } catch (error) {
    logger.error('[generateAzureSasUrl] Error generating SAS URL:', error);
    throw error;
  }
}

/**
 * Checks if an Azure SAS URL needs to be refreshed
 * @param {string} sasUrl - The Azure SAS URL
 * @param {number} bufferSeconds - Buffer time in seconds before expiry to trigger refresh
 * @returns {boolean} True if the URL needs refreshing
 */
function needsAzureRefresh(sasUrl, bufferSeconds = 300) {
  try {
    const url = new URL(sasUrl);

    // Check if it has a SAS token (se = expiry parameter)
    const expiryParam = url.searchParams.get('se');
    if (!expiryParam) {
      // No SAS token, check if public access is enabled
      if (AZURE_STORAGE_PUBLIC_ACCESS?.toLowerCase() === 'true') {
        return false; // Public access, no refresh needed
      }
      // Private blob without SAS token - needs refresh
      return true;
    }

    // Parse the expiry time (ISO 8601 format)
    const expiresAt = new Date(expiryParam);
    const now = new Date();
    const bufferTime = new Date(now.getTime() + bufferSeconds * 1000);

    return expiresAt <= bufferTime;
  } catch (error) {
    logger.error('[needsAzureRefresh] Error checking URL expiration:', error);
    // If we can't determine, assume it needs refresh to be safe
    return true;
  }
}

/**
 * Extracts the blob path from an Azure blob URL
 * @param {string} azureUrl - The Azure blob URL
 * @returns {string | null} The blob path or null if extraction fails
 */
function extractBlobPathFromAzureUrl(azureUrl) {
  try {
    const url = new URL(azureUrl);
    // URL format: https://account.blob.core.windows.net/container/path/to/blob?sasToken
    // We need to extract: path/to/blob
    const pathParts = url.pathname.split('/');
    // First part is empty, second is container name, rest is blob path
    if (pathParts.length < 3) {
      return null;
    }
    return pathParts.slice(2).join('/');
  } catch (error) {
    logger.error('[extractBlobPathFromAzureUrl] Error extracting blob path:', error);
    return null;
  }
}

/**
 * Generates a new SAS URL for an expired Azure blob URL
 * @param {string} currentURL - The current Azure blob URL
 * @returns {Promise<string | undefined>} The new URL with fresh SAS token
 */
async function getNewAzureURL(currentURL) {
  try {
    const blobPath = extractBlobPathFromAzureUrl(currentURL);
    if (!blobPath) {
      logger.warn('[getNewAzureURL] Could not extract blob path from URL:', currentURL);
      return;
    }

    return await generateAzureSasUrl(blobPath);
  } catch (error) {
    logger.error('[getNewAzureURL] Error generating new Azure URL:', error);
    return;
  }
}

/**
 * Uploads a buffer to Azure Blob Storage.
 *
 * Files will be stored at the path: {basePath}/{userId}/{fileName} within the container.
 *
 * @param {Object} params
 * @param {string} params.userId - The user's id.
 * @param {Buffer} params.buffer - The buffer to upload.
 * @param {string} params.fileName - The name of the file.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<string>} The URL of the uploaded blob (with SAS token if private).
 */
async function saveBufferToAzure({
  userId,
  buffer,
  fileName,
  basePath = defaultBasePath,
  containerName,
}) {
  try {
    const containerClient = await getAzureContainerClient(containerName);
    const isPublicAccess = AZURE_STORAGE_PUBLIC_ACCESS?.toLowerCase() === 'true';
    const access = isPublicAccess ? 'blob' : undefined;
    // Create the container if it doesn't exist. This is done per operation.
    await containerClient.createIfNotExists({ access });
    const blobPath = `${basePath}/${userId}/${fileName}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
    await blockBlobClient.uploadData(buffer);

    // Return SAS URL for private blobs, raw URL for public blobs
    if (!isPublicAccess) {
      return await generateAzureSasUrl(blobPath, containerName);
    }
    return blockBlobClient.url;
  } catch (error) {
    logger.error('[saveBufferToAzure] Error uploading buffer:', error);
    throw error;
  }
}

/**
 * Saves a file from a URL to Azure Blob Storage.
 *
 * @param {Object} params
 * @param {string} params.userId - The user's id.
 * @param {string} params.URL - The URL of the file.
 * @param {string} params.fileName - The name of the file.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<string>} The URL of the uploaded blob.
 */
async function saveURLToAzure({
  userId,
  URL,
  fileName,
  basePath = defaultBasePath,
  containerName,
}) {
  try {
    const response = await fetch(URL);
    const buffer = await response.buffer();
    return await saveBufferToAzure({ userId, buffer, fileName, basePath, containerName });
  } catch (error) {
    logger.error('[saveURLToAzure] Error uploading file from URL:', error);
    throw error;
  }
}

/**
 * Retrieves a blob URL from Azure Blob Storage.
 *
 * @param {Object} params
 * @param {string} params.fileName - The file name.
 * @param {string} [params.basePath='images'] - The base folder used during upload.
 * @param {string} [params.userId] - If files are stored in a user-specific directory.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<string>} The blob's URL.
 */
async function getAzureURL({ fileName, basePath = defaultBasePath, userId, containerName }) {
  try {
    const containerClient = await getAzureContainerClient(containerName);
    const blobPath = userId ? `${basePath}/${userId}/${fileName}` : `${basePath}/${fileName}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
    return blockBlobClient.url;
  } catch (error) {
    logger.error('[getAzureURL] Error retrieving blob URL:', error);
    throw error;
  }
}

/**
 * Deletes a blob from Azure Blob Storage.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req - The Express request object.
 * @param {MongoFile} params.file - The file object.
 */
async function deleteFileFromAzure(req, file) {
  try {
    const containerClient = await getAzureContainerClient(AZURE_CONTAINER_NAME);
    const blobPath = file.filepath.split(`${AZURE_CONTAINER_NAME}/`)[1];
    if (!blobPath.includes(req.user.id)) {
      throw new Error('User ID not found in blob path');
    }
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
    await blockBlobClient.delete();
    logger.debug('[deleteFileFromAzure] Blob deleted successfully from Azure Blob Storage');
  } catch (error) {
    logger.error('[deleteFileFromAzure] Error deleting blob:', error);
    if (error.statusCode === 404) {
      return;
    }
    throw error;
  }
}

/**
 * Streams a file from disk directly to Azure Blob Storage without loading
 * the entire file into memory.
 *
 * @param {Object} params
 * @param {string} params.userId - The user's id.
 * @param {string} params.filePath - The local file path to upload.
 * @param {string} params.fileName - The name of the file in Azure.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<string>} The URL of the uploaded blob.
 */
async function streamFileToAzure({
  userId,
  filePath,
  fileName,
  basePath = defaultBasePath,
  containerName,
}) {
  try {
    const containerClient = await getAzureContainerClient(containerName);
    const access = AZURE_STORAGE_PUBLIC_ACCESS?.toLowerCase() === 'true' ? 'blob' : undefined;

    // Create the container if it doesn't exist
    await containerClient.createIfNotExists({ access });

    const blobPath = `${basePath}/${userId}/${fileName}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

    // Get file size for proper content length
    const stats = await fs.promises.stat(filePath);

    // Create read stream from the file
    const fileStream = fs.createReadStream(filePath);

    const blobContentType = mime.getType(fileName);
    await blockBlobClient.uploadStream(
      fileStream,
      undefined, // Use default concurrency (5)
      undefined, // Use default buffer size (8MB)
      {
        blobHTTPHeaders: {
          blobContentType,
        },
        onProgress: (progress) => {
          logger.debug(
            `[streamFileToAzure] Upload progress: ${progress.loadedBytes} bytes of ${stats.size}`,
          );
        },
      },
    );

    return blockBlobClient.url;
  } catch (error) {
    logger.error('[streamFileToAzure] Error streaming file:', error);
    throw error;
  }
}

/**
 * Uploads a file from the local file system to Azure Blob Storage.
 *
 * This function reads the file from disk and then uploads it to Azure Blob Storage
 * at the path: {basePath}/{userId}/{fileName}.
 *
 * @param {Object} params
 * @param {object} params.req - The Express request object.
 * @param {Express.Multer.File} params.file - The file object.
 * @param {string} params.file_id - The file id.
 * @param {string} [params.basePath='images'] - The base folder within the container.
 * @param {string} [params.containerName] - The Azure Blob container name.
 * @returns {Promise<{ filepath: string, bytes: number }>} An object containing the blob URL and its byte size.
 */
async function uploadFileToAzure({
  req,
  file,
  file_id,
  basePath = defaultBasePath,
  containerName,
}) {
  try {
    const inputFilePath = file.path;
    const stats = await fs.promises.stat(inputFilePath);
    const bytes = stats.size;
    const userId = req.user.id;
    const fileName = `${file_id}__${path.basename(inputFilePath)}`;

    const fileURL = await streamFileToAzure({
      userId,
      filePath: inputFilePath,
      fileName,
      basePath,
      containerName,
    });

    return { filepath: fileURL, bytes };
  } catch (error) {
    logger.error('[uploadFileToAzure] Error uploading file:', error);
    throw error;
  }
}

/**
 * Retrieves a readable stream for a blob from Azure Blob Storage.
 *
 * @param {object} _req - The Express request object.
 * @param {string} filepath - The blob path (e.g., "images/userId/fileName") or full URL.
 * @returns {Promise<ReadableStream>} A readable stream of the blob.
 */
async function getAzureFileStream(_req, filepath) {
  try {
    const containerClient = await getAzureContainerClient(AZURE_CONTAINER_NAME);
    let blobPath;
    
    // Handle various path formats
    if (filepath.startsWith('http')) {
      // Full Azure blob URL
      blobPath = filepath.split(`${AZURE_CONTAINER_NAME}/`)[1];
    } else if (filepath.startsWith('/images/')) {
      // Relative path like /images/userId/fileName
      blobPath = filepath.substring(1); // Remove leading slash
    } else if (filepath.startsWith('images/')) {
      // Already in correct format
      blobPath = filepath;
    } else {
      throw new Error(`Invalid file path format: ${filepath}`);
    }
    
    if (!blobPath) {
      throw new Error(`Could not extract blob path from: ${filepath}`);
    }
    
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
    const downloadResponse = await blockBlobClient.download();
    
    return downloadResponse.readableStreamBody;
  } catch (error) {
    logger.error('[getAzureFileStream] Error getting blob stream:', error);
    throw error;
  }
}

module.exports = {
  saveBufferToAzure,
  saveURLToAzure,
  getAzureURL,
  deleteFileFromAzure,
  uploadFileToAzure,
  getAzureFileStream,
  generateAzureSasUrl,
  needsAzureRefresh,
  getNewAzureURL,
};
