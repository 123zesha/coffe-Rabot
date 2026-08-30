const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.resolve(__dirname, '..', 'frontend')));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
