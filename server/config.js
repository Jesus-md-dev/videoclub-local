const path = require('path');
require('dotenv').config();

const VIDEOS_PATH = process.env.VIDEOS_PATH
  ? path.resolve(process.env.VIDEOS_PATH)
  : null;

const PORT = parseInt(process.env.PORT, 10) || 3000;

const DATA_PATH = path.join(__dirname, '..', 'data');
const THUMBNAILS_PATH = path.join(DATA_PATH, 'thumbnails');

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v'];

module.exports = {
  VIDEOS_PATH,
  PORT,
  DATA_PATH,
  THUMBNAILS_PATH,
  VIDEO_EXTENSIONS,
};
