const express = require('express');
const mime = require('mime');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const staticCache = require('../utils/staticCache');
const paths = require('~/config/paths');
const { FileSources } = require('librechat-data-provider');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');

const skipGzipScan = !isEnabled(process.env.ENABLE_IMAGE_OUTPUT_GZIP_SCAN);

const router = express.Router();

// Check file source and serve from appropriate storage
router.use(async (req, res, next) => {
  try {
    const fileSource = process.env.CDN_PROVIDER || FileSources.local;
    
    // Only handle Azure files here
    if (fileSource !== FileSources.azure_blob) {
      return next();
    }
    
    // For Azure, stream the file from Azure Blob Storage
    const { getDownloadStream } = getStrategyFunctions(FileSources.azure_blob);
    if (!getDownloadStream) {
      return next();
    }
    
    // Request path is like /695e9d8ef2a9cf7cd05dc486/filename.png
    // We need to prepend 'images/' to match Azure blob path
    const filepath = `images${req.path}`;
    
    try {
      const stream = await getDownloadStream(req, filepath);
      
      // Detect content type from filename
      const contentType = mime.getType(req.path) || 'application/octet-stream';
      
      // Set appropriate headers
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      
      // Pipe the stream to response
      stream.pipe(res);
    } catch (error) {
      logger.error('[static route] Error streaming Azure file:', error);
      return next(); // Fall through to regular static handler
    }
  } catch (error) {
    logger.error('[static route] Error in Azure middleware:', error);
    next();
  }
});

router.use(staticCache(paths.imageOutput, { skipGzipScan }));

module.exports = router;
