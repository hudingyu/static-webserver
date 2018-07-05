const path = require('path');

const mimeTypes = {
    css: 'text/css',
    gif: 'image/gif',
    html: 'text/html',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    png: 'image/png',
    jpg: 'image/jpg',
    txt: 'text/plain',
    json: 'application/json',
    js: 'text/javascript',
};

const lookup = (pathName) => {
    let ext = path.extname(pathName);
    ext = ext.split('.').pop();
    return mimeTypes[ext] || mimeTypes['txt'];
};

module.exports = { lookup };