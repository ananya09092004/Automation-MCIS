const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Image storage
const imageStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'mcis-images',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    resource_type: 'image'
  }
});

// File storage (PDF, docs)
const fileStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: 'mcis-files',
    resource_type: 'raw',
    allowed_formats: ['pdf', 'doc', 'docx', 'txt'],
    public_id: `${Date.now()}-${file.originalname}`
  })
});

const uploadImage = multer({ storage: imageStorage });
const uploadFile = multer({ storage: fileStorage });

module.exports = { cloudinary, uploadImage, uploadFile };