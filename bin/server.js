/**
 * @fileOverview
 * @name server.js
 * @author hudingyu <hudingyu@meituan.com>
 * @date 2018/7/1
 * @license MIT
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const url = require('url');
const zlib = require('zlib');
const config = require('./../config/default.json');
const mime = require('./mime');

var options = require( "yargs" )
    .option( "p", { alias: "port",  describe: "Port number", type: "number" } )
    .option( "r", { alias: "root", describe: "Static resource directory", type: "string" } )
    .option( "i", { alias: "index", describe: "Default page", type: "string" } )
    .option( "c", { alias: "cachecontrol", default: true, describe: "Use Cache-Control", type: "boolean" } )
    .option( "e", { alias: "expires", default: true, describe: "Use Expires", type: "boolean" } )
    .option( "t", { alias: "etag", default: true, describe: "Use ETag", type: "boolean" } )
    .option( "l", { alias: "lastmodified", default: true, describe: "Use Last-Modified", type: "boolean" } )
    .option( "m", { alias: "maxage", describe: "Time a file should be cached for", type: "number" } )
    .help()
    .alias( "?", "help" )
    .argv;

const hasTrailingSlash = url => url[url.length - 1] === '/';

class StaticServer {
    constructor() {
        this.port = options.p || config.port;
        this.root = options.r || config.root;
        this.indexPage = options.i || config.indexPage;
        this.enableCacheControl = options.c;;
        this.enableExpires = options.e;
        this.enableETag = options.t;
        this.enableLastModified = options.l;
        this.maxAge = options.m || config.maxAge;
        this.zipMatch = new RegExp(config.zipMatch);
    }

    getRange(rangeText, totalSize) {
        const matchResults = rangeText.match(/bytes=([0-9]*)-([0-9]*)/);
        let start = parseInt(matchResults[1]);
        let end = parseInt(matchResults[2]);
        if (isNaN(start) && !isNaN(end)) {
            start = totalSize - end;
            end = totalSize - 1;
        } else if (!isNaN(start) && isNaN(end)) {
            end = totalSize - 1;
        }
        return {
            start,
            end
        };
    }

    rangeHandler(pathName, rangeText, totalSize, res) {
        const range = this.getRange(rangeText, totalSize);
        if (range.start > range.end || range.start > totalSize || range.end > totalSize) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${totalSize}`);
            res.end();
            return null;
        } else {
            res.statusCode = 206;
            res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
            return fs.createReadStream(pathName, { start: range.start, end: range.end});
        }
    }

    shouldCompress(pathName) {
        return path.extname(pathName).match(this.zipMatch);
    }

    compressHandler(readStream, req, res) {
        const acceptEncoding = req.headers['accept-encoding'];
        if (!acceptEncoding || !acceptEncoding.match(/\b(gzip|deflate)\b/)) {
            return readStream;
        } else if (acceptEncoding.match(/\bgzip\b/)) {
            res.setHeader('Content-Encoding', 'gzip');
            return readStream.pipe(zlib.createGzip());
        } else if (acceptEncoding.match(/\bdeflate\b/)) {
            res.setHeader('Content-Encoding', 'deflate');
            return readStream.pipe(zlib.createDeflate());
        }
    }

    respondFile(stat, pathName, req, res) {
        let readStream;
        // const readStream = fs.createReadStream(pathName);
        res.setHeader('Content-Type', mime.lookup(pathName));
        res.setHeader('Accept-Ranges', 'bytes');
        if (req.headers['range']) {
            readStream = this.rangeHandler(pathName, req.headers['range'], stat.size, res);
            if (!readStream) return;
        } else {
            readStream = fs.createReadStream(pathName);
        }
        if (this.shouldCompress(pathName)) {
            readStream = this.compressHandler(readStream, req, res);
        }
        readStream.pipe(res);
    }

    generateETag(stat) {
        const mtime = stat.mtime.getTime().toString(16);
        const size = stat.size.toString();
        return `W/"${size}-${mtime}"`;
    }

    setFreshHeaders(stat, res) {
        const lastModified = stat.mtime.toUTCString();
        if (this.enableLastModified) {
            res.setHeader('Last-Modified', lastModified);
        }
        if (this.enableCacheControl) {
            res.setHeader('Cache-Control', `public, max-age=${this.maxAge}`);
        }
        if (this.enableETag) {
            res.setHeader('ETag', this.generateETag(stat));
        }
        if (this.enableExpires) {
            const expireTime = (new Date(Date.now() + this.maxAge * 1000)).toUTCString();
            res.setHeader('Expires', expireTime);
        }
    }

    isFresh(reqHeaders, resHeaders) {
        const noneMatch = reqHeaders['if-none-match'];
        const lastModified = reqHeaders['if-modified-since'];
        if (!noneMatch && !lastModified) return false;
        if (noneMatch && (noneMatch !== resHeaders['etag'])) return false;
        if (lastModified && (lastModified !== resHeaders['last-modified'])) return false;
        return true;
    }

    respondNotModified(res) {
        res.statusCode = 304;
        res.end();
    }

    respondError(err, res) {
        res.writeHead(500);
        res.end(err);
    }

    respond(pathName, req, res) {
        fs.stat(pathName, (err, stat) => {
            if (!err) {
                this.setFreshHeaders(stat, res);
                if (this.isFresh(req.headers, res._headers)) {
                    this.respondNotModified(res);
                } else {
                    this.respondFile(stat, pathName, req, res);
                }
            } else {
                this.respondError(err, res);
            }
        });
    }

    respondNotFound(req, res) {
        res.writeHead(400, {
            'Content-Type': 'text/html'
        });
        res.end(`<h1>Not Found</h1><p>The requested URL ${req.url} was not found on this server.</p>`);
    }

    respondDirectory(pathName, req, res) {
        const indexPagePath = path.join(pathName, this.indexPage);
        if (fs.existsSync(indexPagePath)) {
            this.respond(indexPagePath, req, res);
        } else {
            fs.readdir(pathName, (err, files) => {
                if (!err) {
                    const requestPath = url.parse(req.url).pathname;
                    let content = `<h1>Index of ${requestPath}:</h1>`;
                    files.forEach(file => {
                        let filePath = path.join(requestPath, file); //实际文件的相对路径
                        const stat = fs.statSync(path.join(pathName, file)); //实际文件的实际路径
                        if (stat && stat.isDirectory()) {
                            filePath = path.join(filePath, '/');
                            file = path.join(file, '/');
                        }
                        content += `<p><a href='${filePath}'>${file}</a></a></p>`;
                    });
                    res.writeHead(200, {
                        'Content-Type': 'text/html'
                    });
                    res.end(content);
                } else {
                    res.writeHead(500);
                    res.end(err);
                }
            });
        }
    }

    respondRedirect(req, res) {
        const location = req.url + '/';
        res.writeHead(301, {
            'Location': location,
            'Content-type': 'text/html'
        });
        res.end(`Redirecting to <a href='${location}'>${location}</a>`);
    }

    routeHandler(pathName, req, res) {
        if (pathName.indexOf('article/') >= 0 || pathName.indexOf('homepage') >= 0) {
            this.respondFile(null, path.join(this.root, this.indexPage), req, res);
        } else {
            fs.stat(pathName, (err, stat) => {
                if (!err) {
                    const requestedPath = url.parse(req.url).pathname;
                    if (hasTrailingSlash(requestedPath) && stat.isDirectory()) {
                        this.respondDirectory(pathName, req, res);
                    } else if (stat.isDirectory()) {
                        this.respondRedirect(req, res);
                    } else {
                        this.respond(pathName, req, res);
                    }
                } else {
                    this.respondNotFound(req, res);
                }
            });
        }
    }

    start() {
        http.createServer((req, res) => {
            if (req.url.indexOf('static') > 0) {
                req.url = req.url.substring(req.url.indexOf('static'));
            }
            const pathName = path.join(this.root, path.normalize(req.url));
            this.routeHandler(pathName, req, res);
            // res.writeHead(200);
            // res.end(`Request path: ${pathName}`);
        }).listen(this.port, err => {
            if (err) {
                console.log(err);
                console.info('Failed to start server..');
            } else {
                console.info(`Server started on port ${this.port}`);
            }
        });
    }
}

module.exports = StaticServer;