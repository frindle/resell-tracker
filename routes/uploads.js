// Upload routes for handling photo uploads
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const storage = multer.memoryStorage();

router.post('/upload', (req, res) => {
  // Handle multiple file uploads
});

module.exports = router;