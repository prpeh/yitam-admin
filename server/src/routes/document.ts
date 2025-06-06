import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import * as documentController from '../controllers/document';

const router = express.Router();

// Ensure uploads directory exists
const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

// File filter to accept only specific document types
const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedFileTypes = [
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/tiff'
  ];
  
  if (allowedFileTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('File type not supported. Please upload PDF, TXT, DOCX, or image files (PNG, JPEG, TIFF).'));
  }
};

const upload = multer({ 
  storage, 
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB file size limit
});

// Routes
router.post('/upload', upload.single('document'), documentController.parseAndStoreDocument);
router.post('/upload-folder', upload.array('documents', 50), documentController.parseAndStoreImageFolder);
router.get('/search', documentController.searchDocuments);

// New routes for document management
router.get('/list', documentController.listDocuments);
router.get('/search-by-name', documentController.searchDocumentsByName);
router.get('/chunks/:documentName', documentController.getChunksByDocumentName);
router.delete('/chunks', documentController.deleteChunks);

export default router; 