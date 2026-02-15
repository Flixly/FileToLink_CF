// ---------- Insert Your Data ---------- //

const BOT_TOKEN = "BOT_TOKEN"; // Insert your bot token.
const BOT_WEBHOOK = "/endpoint"; // Let it be as it is.
const BOT_SECRET = "BOT_SECRET"; // Insert a powerful secret text.
const BOT_OWNER = 1008848605; // Insert your telegram account id.
const BOT_CHANNEL = -1002199235178; // Insert your channel id.
const SIA_SECRET = "SIA_SECRET"; // Insert a powerful secret text.
const PUBLIC_BOT = false; // Make your bot public?
const OWNER_USERNAME = "FLiX_LY"; // Insert your username.
const BOT_NAME = "FileStream Bot"; // Bot Name.




// ---------- Do Not Modify ---------- // 

const WHITE_METHODS = ["GET", "POST", "HEAD"];
const HEADERS_ERRR = {'Access-Control-Allow-Origin': '*', 'content-type': 'application/json'};

// File size limits in bytes
const MAX_TELEGRAM_SIZE = 4 * 1024 * 1024 * 1024; // 4GB for Telegram/Inline
const MAX_STREAM_SIZE = 2 * 1024 * 1024 * 1024; // 2GB for direct stream/download

// Performance optimization
const CACHE_DURATION = 3600; // 1 hour cache
const FILE_INFO_CACHE = new Map(); // In-memory cache for file metadata

const ERROR_404 = {"ok":false,"error_code":404,"description":"Bad Request: missing /?file= parameter", "credit": "https://github.com/vauth/filestream-cf"};
const ERROR_405 = {"ok":false,"error_code":405,"description":"Bad Request: method not allowed"};
const ERROR_406 = {"ok":false,"error_code":406,"description":"Bad Request: file type invalid"};
const ERROR_407 = {"ok":false,"error_code":407,"description":"Bad Request: file hash invalid by atob"};
const ERROR_408 = {"ok":false,"error_code":408,"description":"Bad Request: mode not in [attachment, inline, stream]"};
const ERROR_410 = {"ok":false,"error_code":410,"description":"Bad Request: file size exceeds streaming limit (2GB max)"};
const ERROR_411 = {"ok":false,"error_code":411,"description":"Bad Request: file not found or deleted"};

// ---------- ES Module Export (Fixes D1 Binding) ---------- // 

export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env, ctx);
    }
};

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Bot webhook endpoints
    if (path === BOT_WEBHOOK) {return Bot.handleWebhook(request, env)}
    if (path === '/registerWebhook') {return Bot.registerWebhook(request, url, BOT_WEBHOOK, BOT_SECRET)}
    if (path === '/unregisterWebhook') {return Bot.unregisterWebhook(request)}
    if (path === '/getMe') {return new Response(JSON.stringify(await Bot.getMe()), {headers: HEADERS_ERRR, status: 202})}
    
    // New URL structure: /stream/FileID or /dl/FileID
    let file = null;
    let mode = "attachment";
    
    if (path.startsWith('/stream/')) {
        file = path.replace('/stream/', '');
        mode = "inline";
    } else if (path.startsWith('/dl/')) {
        file = path.replace('/dl/', '');
        mode = "attachment";
    } else if (path === '/stream' || path === '/download') {
        file = url.searchParams.get('file');
        mode = path === '/stream' ? 'inline' : 'attachment';
    } else {
        file = url.searchParams.get('file');
        mode = url.searchParams.get('mode') || "attachment";
    }
    
    // Home page (only if no file is requested)
    if (path === '/' && !file) {
        return new Response(await getHomePage(), {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': `public, max-age=${CACHE_DURATION}`
            }
        })
    }
    
    // Streaming page with player
    if (path === '/streampage' && file) {
        return new Response(await getStreamPage(url, file, env), {headers: {'Content-Type': 'text/html; charset=utf-8'}})
    }

    if (!file) {return Raise(ERROR_404, 404);}
    if (!["attachment", "inline", "stream"].includes(mode)) {return Raise(ERROR_408, 404)}
    if (!WHITE_METHODS.includes(request.method)) {return Raise(ERROR_405, 405);}
    
    try {await Cryptic.deHash(file)} catch {return Raise(ERROR_407, 404)}

    const channel_id = BOT_CHANNEL;
    const file_id = await Cryptic.deHash(file);
    
    // Check if file exists in database
    if (env && env.DB) {
        const fileExists = await DB.getFile(env.DB, file_id);
        if (!fileExists) {
            return Raise(ERROR_411, 404);
        }
        
        // Update stats asynchronously (non-blocking)
        ctx.waitUntil(DB.incrementDownloads(env.DB, file_id));
    }
    
    // Validate file size before retrieving (with caching for performance)
    const fileInfo = await getFileInfoCached(channel_id, file_id);
    if (fileInfo.error_code) {return await Raise(fileInfo, fileInfo.error_code)};
    
    const fSize = fileInfo.size;
    const fType = fileInfo.type;
    
    // Check size limits based on mode
    if (fSize > MAX_STREAM_SIZE && (mode === 'inline' || mode === 'attachment')) {
        return Raise(ERROR_410, 413);
    }
    
    const retrieve = await RetrieveFile(channel_id, file_id);
    if (retrieve.error_code) {return await Raise(retrieve, retrieve.error_code)};

    const rpath = retrieve[0]
    const rname = retrieve[1]
    const rsize = retrieve[2]
    const rtype = retrieve[3]

    // Stream the file directly from Telegram without loading into memory
    const range = request.headers.get('Range');
    const telegramResponse = await streamFileFromTelegram(rpath, range);
    
    // Clone the response and modify headers
    const headers = new Headers(telegramResponse.headers);
    headers.set("Content-Disposition", `${mode === 'stream' ? 'inline' : mode}; filename=${rname}`);
    headers.set("Content-Type", rtype);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Cache-Control", "public, max-age=3600");
    
    return new Response(telegramResponse.body, {
        status: telegramResponse.status,
        headers: headers
    });
}

// ---------- Database Functions ---------- //

class DB {
    // Initialize database tables
    static async initDB(db) {
        try {
            await db.exec(`
                CREATE TABLE IF NOT EXISTS files (
                    file_id TEXT PRIMARY KEY,
                    message_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    username TEXT,
                    file_name TEXT,
                    file_size INTEGER,
                    file_type TEXT,
                    secret_token TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    downloads INTEGER DEFAULT 0
                );
                
                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    username TEXT,
                    first_name TEXT,
                    last_name TEXT,
                    first_used DATETIME DEFAULT CURRENT_TIMESTAMP,
                    total_files INTEGER DEFAULT 0,
                    last_activity DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                
                CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
                CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at);
            `);
            return true;
        } catch (error) {
            console.error('DB Init Error:', error);
            return false;
        }
    }
    
    // Add new file
    static async addFile(db, fileData) {
        try {
            const stmt = db.prepare(`
                INSERT INTO files (file_id, message_id, user_id, username, file_name, file_size, file_type, secret_token)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            await stmt.bind(
                fileData.file_id,
                fileData.message_id,
                fileData.user_id,
                fileData.username || '',
                fileData.file_name,
                fileData.file_size,
                fileData.file_type,
                fileData.secret_token
            ).run();
            return true;
        } catch (error) {
            console.error('Add File Error:', error);
            return false;
        }
    }
    
    // Get file by ID
    static async getFile(db, fileId) {
        try {
            const result = await db.prepare('SELECT * FROM files WHERE message_id = ?').bind(fileId).first();
            return result;
        } catch (error) {
            console.error('Get File Error:', error);
            return null;
        }
    }
    
    // Get file by secret token
    static async getFileByToken(db, token) {
        try {
            const result = await db.prepare('SELECT * FROM files WHERE secret_token = ?').bind(token).first();
            return result;
        } catch (error) {
            return null;
        }
    }
    
    // Delete file
    static async deleteFile(db, fileId) {
        try {
            await db.prepare('DELETE FROM files WHERE message_id = ?').bind(fileId).run();
            return true;
        } catch (error) {
            console.error('Delete File Error:', error);
            return false;
        }
    }
    
    // Delete all files
    static async deleteAllFiles(db) {
        try {
            await db.prepare('DELETE FROM files').run();
            return true;
        } catch (error) {
            console.error('Delete All Files Error:', error);
            return false;
        }
    }
    
    // Get user files
    static async getUserFiles(db, userId) {
        try {
            const result = await db.prepare(
                'SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
            ).bind(userId).all();
            return result.results || [];
        } catch (error) {
            console.error('Get User Files Error:', error);
            return [];
        }
    }
    
    // Register/Update user
    static async registerUser(db, userData) {
        try {
            const stmt = db.prepare(`
                INSERT INTO users (user_id, username, first_name, last_name, total_files)
                VALUES (?, ?, ?, ?, 1)
                ON CONFLICT(user_id) DO UPDATE SET
                    username = excluded.username,
                    first_name = excluded.first_name,
                    last_name = excluded.last_name,
                    total_files = total_files + 1,
                    last_activity = CURRENT_TIMESTAMP
            `);
            await stmt.bind(
                userData.user_id,
                userData.username || '',
                userData.first_name || '',
                userData.last_name || ''
            ).run();
            return true;
        } catch (error) {
            console.error('Register User Error:', error);
            return false;
        }
    }
    
    // Increment download counter
    static async incrementDownloads(db, fileId) {
        try {
            await db.prepare('UPDATE files SET downloads = downloads + 1 WHERE message_id = ?').bind(fileId).run();
            return true;
        } catch (error) {
            return false;
        }
    }
    
    // Get stats
    static async getStats(db) {
        try {
            const totalFiles = await db.prepare('SELECT COUNT(*) as count FROM files').first();
            const totalUsers = await db.prepare('SELECT COUNT(*) as count FROM users').first();
            const totalDownloads = await db.prepare('SELECT SUM(downloads) as total FROM files').first();
            
            return {
                totalFiles: totalFiles.count || 0,
                totalUsers: totalUsers.count || 0,
                totalDownloads: totalDownloads.total || 0
            };
        } catch (error) {
            return { totalFiles: 0, totalUsers: 0, totalDownloads: 0 };
        }
    }
}

// ---------- Helper: Generate Secret Token ---------- //
async function generateSecretToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 16; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
}

// ---------- Helper: Markdown Sanitizer ---------- //
function escapeMarkdown(text) {
    if (!text) return 'Unknown File';
    return text.replace(/`/g, "'");
}


// ---------- Helper: File Size Formatter ---------- //
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ---------- Get File Info ---------- //

async function getFileInfo(channel_id, message_id) {
    let data = await Bot.editMessage(channel_id, message_id, await UUID());
    if (data.error_code){return data}
    
    let fSize = 0;
    let fType = "";
    
    if (data.document){
        fSize = data.document.file_size;
        fType = data.document.mime_type;
    } else if (data.audio) {
        fSize = data.audio.file_size;
        fType = data.audio.mime_type;
    } else if (data.video) {
        fSize = data.video.file_size;
        fType = data.video.mime_type;
    } else if (data.photo) {
        const fLen = data.photo.length - 1;
        fSize = data.photo[fLen].file_size;
        fType = "image/jpeg";
    } else {
        return ERROR_406
    }
    
    return {size: fSize, type: fType};
}

// ---------- Cached File Info (Performance Optimization) ---------- //

async function getFileInfoCached(channel_id, message_id) {
    const cacheKey = `${channel_id}:${message_id}`;
    const now = Date.now();
    
    // Check cache
    if (FILE_INFO_CACHE.has(cacheKey)) {
        const cached = FILE_INFO_CACHE.get(cacheKey);
        if (now - cached.timestamp < CACHE_DURATION * 1000) {
            return cached.data;
        }
        FILE_INFO_CACHE.delete(cacheKey);
    }
    
    // Fetch fresh data
    const fileInfo = await getFileInfo(channel_id, message_id);
    
    // Cache successful responses
    if (!fileInfo.error_code) {
        FILE_INFO_CACHE.set(cacheKey, {
            data: fileInfo,
            timestamp: now
        });
        
        // Cleanup old cache entries (keep max 1000 entries)
        if (FILE_INFO_CACHE.size > 1000) {
            const firstKey = FILE_INFO_CACHE.keys().next().value;
            FILE_INFO_CACHE.delete(firstKey);
        }
    }
    
    return fileInfo;
}

// ---------- Retrieve File ---------- //

async function RetrieveFile(channel_id, message_id) {
    let  fID; let fName; let fType; let fSize; let fLen;
    let data = await Bot.editMessage(channel_id, message_id, await UUID());
    if (data.error_code){return data}
    
    if (data.document){
        fLen = data.document.length - 1
        fID = data.document.file_id;
        fName = data.document.file_name;
        fType = data.document.mime_type;
        fSize = data.document.file_size;
    } else if (data.audio) {
        fLen = data.audio.length - 1
        fID = data.audio.file_id;
        fName = data.audio.file_name;
        fType = data.audio.mime_type;
        fSize = data.audio.file_size;
    } else if (data.video) {
        fLen = data.video.length - 1
        fID = data.video.file_id;
        fName = data.video.file_name;
        fType = data.video.mime_type;
        fSize = data.video.file_size;
    } else if (data.photo) {
        fLen = data.photo.length - 1
        fID = data.photo[fLen].file_id;
        fName = data.photo[fLen].file_unique_id + '.jpg';
        fType = "image/jpg";
        fSize = data.photo[fLen].file_size;
    } else {
        return ERROR_406
    }

    const file = await Bot.getFile(fID)
    if (file.error_code){return file}

    // Return file info instead of full file data for streaming
    return [file.file_path, fName, fSize, fType];
}

// ---------- Stream File from Telegram ---------- //

async function streamFileFromTelegram(filePath, rangeHeader) {
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    
    // Forward the range request to Telegram
    const headers = {};
    if (rangeHeader) {
        headers['Range'] = rangeHeader;
    }
    
    const response = await fetch(fileUrl, { headers });
    return response;
}

// ---------- Raise Error ---------- //

async function Raise(json_error, status_code) {
    return new Response(JSON.stringify(json_error), { headers: HEADERS_ERRR, status: status_code });
}

// ---------- Range Request Handler (Legacy - not used anymore) ---------- //
// Now using direct streaming from Telegram API

// ---------- Stream Page Generator ---------- //

async function getStreamPage(url, fileHash, env) {
    const bot = await Bot.getMe();
    const streamUrl = `${url.origin}/stream/${fileHash}`;
    const downloadUrl = `${url.origin}/dl/${fileHash}`;
    const telegramUrl = `https://t.me/${bot.username}/?start=${fileHash}`;
     
    let fileName = 'Media File';
    let fileType = 'video';
    let fileSize = 0;
    let downloads = 0;
    
    try {
        const channel_id = BOT_CHANNEL;
        const file_id = await Cryptic.deHash(fileHash);
        
        // Get file data from DB if available
        if (env && env.DB) {
            const fileData = await DB.getFile(env.DB, file_id);
            if (fileData) {
                fileName = fileData.file_name;
                fileSize = fileData.file_size;
                fileType = fileData.file_type;
                downloads = fileData.downloads || 0;
            }
        }
        
        // Fallback to Telegram API if DB not available
        if (!fileName || fileName === 'Media File') {
            const data = await Bot.editMessage(channel_id, file_id, await UUID());
            
            if (data.document) {
                fileName = data.document.file_name;
                fileSize = data.document.file_size;
                fileType = data.document.mime_type.startsWith('video') ? 'video' : 
                          data.document.mime_type.startsWith('audio') ? 'audio' : 'document';
            } else if (data.video) {
                fileName = data.video.file_name || 'Video File';
                fileSize = data.video.file_size;
                fileType = 'video';
            } else if (data.audio) {
                fileName = data.audio.file_name || 'Audio File';
                fileSize = data.audio.file_size;
                fileType = 'audio';
            }
        }
    } catch (e) {}
     
    const vlcUrl = `vlc://${streamUrl.replace('https://', '').replace('http://', '')}`;
    const mxUrl = `intent:${streamUrl}#Intent;package=com.mxtech.videoplayer.ad;end`;
    
    // Truncate filename for title if too long (max 50 chars)
    const truncatedFileName = fileName.length > 50 ? fileName.substring(0, 47) + '...' : fileName;
    const pageTitle = `Watch ${truncatedFileName} | ${BOT_NAME}`;
     
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pageTitle}</title>
    <link rel="icon" type="image/png" href="https://i.ibb.co/pQ0tSCj/1232b12e0a0c.png">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Poppins', sans-serif;
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 50%, #7e22ce 100%);
            min-height: 100vh;
            padding: 20px;
            overflow-x: hidden;
            position: relative;
        }
        /* Premium animated background */
        body::before {
            content: '';
            position: fixed;
            width: 200%;
            height: 200%;
            top: -50%;
            left: -50%;
            z-index: 0;
            background: radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px);
            background-size: 50px 50px;
            animation: moveBackground 20s linear infinite;
        }
        @keyframes moveBackground {
            0% { transform: translate(0, 0); }
            100% { transform: translate(50px, 50px); }
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            position: relative;
            z-index: 1;
        }
        .header {
            text-align: center;
            color: white;
            margin-bottom: 30px;
            animation: fadeInDown 0.8s ease;
        }
        .header h1 {
            font-size: 3em;
            font-weight: 800;
            text-shadow: 0 4px 20px rgba(0,0,0,0.5);
            margin-bottom: 10px;
            background: linear-gradient(135deg, #fff, #e0e7ff);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .header p {
            font-size: 1.2em;
            opacity: 0.95;
            text-shadow: 0 2px 10px rgba(0,0,0,0.2);
        }
        .main-card {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(20px) saturate(180%);
            -webkit-backdrop-filter: blur(20px) saturate(180%);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 30px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.4), 0 0 80px rgba(126, 34, 206, 0.3);
            animation: fadeInUp 0.8s ease;
        }
        .file-info {
            background: linear-gradient(135deg, rgba(30, 60, 114, 0.9), rgba(126, 34, 206, 0.9));
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 30px;
            color: white;
            margin-bottom: 30px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .file-info h2 {
            font-size: 1.8em;
            margin-bottom: 15px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .file-info p {
            font-size: 1em;
            opacity: 0.9;
            margin: 8px 0;
        }
        .player-container {
            background: #000;
            border-radius: 20px;
            overflow: hidden;
            margin-bottom: 30px;
            box-shadow: 0 15px 50px rgba(0,0,0,0.6);
            border: 2px solid rgba(255, 255, 255, 0.1);
            position: relative;
        }
        .player-container::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(45deg, rgba(126, 34, 206, 0.1), transparent);
            pointer-events: none;
        }
        video, audio {
            width: 100%;
            max-height: 70vh;
            display: block;
            outline: none;
            position: relative;
            z-index: 1;
            background: #000;
        }
        .stats-bar {
            display: flex;
            justify-content: space-around;
            padding: 20px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 15px;
            margin-bottom: 20px;
            backdrop-filter: blur(10px);
        }
        .stat-item {
            text-align: center;
            color: white;
        }
        .stat-number {
            font-size: 1.5em;
            font-weight: 700;
            display: block;
            margin-bottom: 5px;
        }
        .stat-label {
            font-size: 0.85em;
            opacity: 0.8;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .buttons-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        .btn {
            padding: 15px 25px;
            border-radius: 15px;
            text-decoration: none;
            color: white;
            font-weight: 600;
            font-variant: small-caps;
            text-align: center;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            border: none;
            cursor: pointer;
            font-size: 1em;
            box-shadow: 0 5px 15px rgba(0,0,0,0.3);
            position: relative;
            overflow: hidden;
        }
        .btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
            transition: left 0.5s;
        }
        .btn:hover::before {
            left: 100%;
        }
        .btn:hover {
            transform: translateY(-3px) scale(1.02);
            box-shadow: 0 10px 30px rgba(0,0,0,0.4);
        }
        .btn-primary { background: linear-gradient(135deg, #7e22ce, #9333ea); }
        .btn-success { background: linear-gradient(135deg, #059669, #10b981); }
        .btn-info { background: linear-gradient(135deg, #0ea5e9, #06b6d4); }
        .btn-warning { background: linear-gradient(135deg, #f59e0b, #fbbf24); }
        .btn-danger { background: linear-gradient(135deg, #dc2626, #ef4444); }
        .btn-telegram { background: linear-gradient(135deg, #0088cc, #229ED9); }
        .link-box {
            background: rgba(255, 255, 255, 0.08);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 15px;
            padding: 20px;
            margin-bottom: 20px;
        }
        .link-box h3 {
            color: #fff;
            margin-bottom: 15px;
            font-size: 1.3em;
            font-weight: 600;
        }
        .link-input-group {
            display: flex;
            gap: 10px;
        }
        .link-input {
            flex: 1;
            padding: 12px 20px;
            border: 2px solid rgba(255, 255, 255, 0.2);
            border-radius: 10px;
            font-size: 0.95em;
            font-family: 'Courier New', monospace;
            background: rgba(0, 0, 0, 0.3);
            color: #fff;
        }
        .copy-btn {
            padding: 12px 25px;
            background: linear-gradient(135deg, #7e22ce, #9333ea);
            color: white;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            font-weight: 600;
            font-variant: small-caps;
            transition: all 0.3s ease;
        }
        .copy-btn:hover {
            transform: scale(1.05);
        }
        .copy-btn.copied {
            background: linear-gradient(135deg, #56ab2f, #a8e063);
        }
        .footer {
            text-align: center;
            margin-top: 30px;
            color: white;
            text-shadow: 0 2px 10px rgba(0,0,0,0.2);
        }
        .footer a {
            color: #ffd700;
            text-decoration: none;
            font-weight: 600;
            transition: all 0.3s ease;
        }
        .footer a:hover {
            color: #ffed4e;
            text-shadow: 0 0 10px rgba(255, 215, 0, 0.5);
        }
        @keyframes fadeInDown {
            from { opacity: 0; transform: translateY(-30px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @media (max-width: 768px) {
            body { padding: 10px; }
            .header h1 { font-size: 1.8em; }
            .header p { font-size: 1em; }
            .main-card { padding: 20px; border-radius: 20px; }
            .file-info { padding: 20px; }
            .file-info h2 { font-size: 1.3em; flex-wrap: wrap; }
            .buttons-grid { grid-template-columns: 1fr; gap: 10px; }
            .btn { padding: 12px 20px; font-size: 0.95em; }
            .link-box { padding: 15px; }
            .link-box h3 { font-size: 1.1em; }
            .link-input-group { flex-direction: column; }
            .link-input { font-size: 0.85em; }
            .stats-bar { flex-direction: column; gap: 15px; padding: 15px; }
        }
        @media (max-width: 480px) {
            .header h1 { font-size: 1.5em; }
            .file-info h2 { font-size: 1.1em; }
            .file-info p { font-size: 0.9em; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fas fa-cloud"></i> ${BOT_NAME}</h1>
            <p>⚡ Premium File Streaming Experience</p>
        </div>
        
        <div class="main-card">
            <div class="file-info">
                <h2>
                    <i class="fas fa-file-${fileType === 'video' ? 'video' : fileType === 'audio' ? 'audio' : 'alt'}"></i>
                    ${fileName}
                </h2>
                <p><i class="fas fa-hdd"></i> ꜱɪᴢᴇ: ${formatSize(fileSize)}</p>
                <p><i class="fas fa-tag"></i> ᴛʏᴘᴇ: ${fileType.toUpperCase()}</p>
                <p><i class="fas fa-check-circle"></i> ꜱᴛᴀᴛᴜꜱ: ʀᴇᴀᴅʏ ᴛᴏ ꜱᴛʀᴇᴀᴍ</p>
            </div>
            
            ${downloads > 0 ? `<div class="stats-bar">
                <div class="stat-item">
                    <span class="stat-number">${downloads}</span>
                    <span class="stat-label">ᴅᴏᴡɴʟᴏᴀᴅꜱ</span>
                </div>
                <div class="stat-item">
                    <span class="stat-number">${formatSize(fileSize)}</span>
                    <span class="stat-label">ꜱɪᴢᴇ</span>
                </div>
                <div class="stat-item">
                    <span class="stat-number"><i class="fas fa-check-circle"></i></span>
                    <span class="stat-label">ᴠᴇʀɪꜰɪᴇᴅ</span>
                </div>
            </div>` : ''}
            
            ${fileType === 'video' ? `
            <div class="player-container">
                <video controls preload="metadata" playsinline crossorigin="anonymous" controlsList="nodownload">
                    <source src="${streamUrl}" type="video/mp4">
                    Your browser does not support the video tag.
                </video>
            </div>` : fileType === 'audio' ? `
            <div class="player-container">
                <audio controls preload="metadata" crossorigin="anonymous" controlsList="nodownload" style="width: 100%;">
                    <source src="${streamUrl}" type="audio/mpeg">
                    Your browser does not support the audio tag.
                </audio>
            </div>` : ''}
            
            <div class="buttons-grid">
                <a href="${downloadUrl}" class="btn btn-primary">
                    <i class="fas fa-download"></i> Download
                </a>
                <button onclick="copyLink('${streamUrl}')" class="btn btn-success" id="copyBtn">
                    <i class="fas fa-copy"></i> Copy Link
                </button>
                ${fileType === 'video' ? `
                <a href="${vlcUrl}" class="btn btn-warning">
                    <i class="fas fa-play-circle"></i> VLC Player
                </a>
                <a href="${mxUrl}" class="btn btn-danger">
                    <i class="fas fa-play"></i> MX Player
                </a>` : ''}
                <a href="${telegramUrl}" class="btn btn-telegram">
                    <i class="fab fa-telegram"></i> Telegram
                </a>
                <button onclick="shareFile()" class="btn btn-info">
                    <i class="fas fa-share-alt"></i> Share
                </button>
            </div>
            
            <div class="link-box">
                <h3><i class="fas fa-link"></i> Direct Stream Link</h3>
                <div class="link-input-group">
                    <input type="text" class="link-input" value="${streamUrl}" readonly id="streamLink">
                    <button class="copy-btn" onclick="copyLink('${streamUrl}')">
                        <i class="fas fa-copy"></i> Copy
                    </button>
                </div>
            </div>
            
            <div class="link-box">
                <h3><i class="fas fa-download"></i> Download Link</h3>
                <div class="link-input-group">
                    <input type="text" class="link-input" value="${downloadUrl}" readonly id="downloadLink">
                    <button class="copy-btn" onclick="copyLink('${downloadUrl}')">
                        <i class="fas fa-copy"></i> Copy
                    </button>
                </div>
            </div>
        </div>
        
        <div class="footer">
            <p>
                <i class="fas fa-crown" style="color: #ffd700;"></i>
                Created with ❤️ by <a href="https://t.me/${OWNER_USERNAME}" target="_blank">@${OWNER_USERNAME}</a>
            </p>
            <p style="margin-top: 10px; opacity: 0.9;">
                Powered by ${BOT_NAME} • Cloudflare Workers
            </p>
        </div>
    </div>
    
    <script>
        function copyLink(text) {
            navigator.clipboard.writeText(text).then(() => {
                const btn = event.target.closest('button');
                const originalHTML = btn.innerHTML;
                btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.innerHTML = originalHTML;
                    btn.classList.remove('copied');
                }, 2000);
            });
        }
        
        function shareFile() {
            if (navigator.share) {
                navigator.share({
                    title: '${fileName}',
                    text: 'Watch/Download this file from ${BOT_NAME}',
                    url: window.location.href
                }).catch(err => console.log('Error sharing:', err));
            } else {
                copyLink(window.location.href);
            }
        }
    </script>
</body>
</html>`;
}

// ---------- Home Page Generator ---------- //

async function getHomePage() {
    const bot = await Bot.getMe();
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${BOT_NAME} - Premium File Streaming</title>
    <link rel="icon" type="image/png" href="https://i.ibb.co/pQ0tSCj/1232b12e0a0c.png">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Poppins', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
            min-height: 100vh;
            overflow-x: hidden;
        }
        
        /* Animated Background */
        .bg-animation {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 0;
            overflow: hidden;
        }
        .bg-animation span {
            position: absolute;
            display: block;
            width: 20px;
            height: 20px;
            background: rgba(255, 255, 255, 0.1);
            animation: animate 25s linear infinite;
            bottom: -150px;
        }
        .bg-animation span:nth-child(1) { left: 25%; width: 80px; height: 80px; animation-delay: 0s; }
        .bg-animation span:nth-child(2) { left: 10%; width: 20px; height: 20px; animation-delay: 2s; animation-duration: 12s; }
        .bg-animation span:nth-child(3) { left: 70%; width: 20px; height: 20px; animation-delay: 4s; }
        .bg-animation span:nth-child(4) { left: 40%; width: 60px; height: 60px; animation-delay: 0s; animation-duration: 18s; }
        .bg-animation span:nth-child(5) { left: 65%; width: 20px; height: 20px; animation-delay: 0s; }
        .bg-animation span:nth-child(6) { left: 75%; width: 110px; height: 110px; animation-delay: 3s; }
        .bg-animation span:nth-child(7) { left: 35%; width: 150px; height: 150px; animation-delay: 7s; }
        .bg-animation span:nth-child(8) { left: 50%; width: 25px; height: 25px; animation-delay: 15s; animation-duration: 45s; }
        .bg-animation span:nth-child(9) { left: 20%; width: 15px; height: 15px; animation-delay: 2s; animation-duration: 35s; }
        .bg-animation span:nth-child(10) { left: 85%; width: 150px; height: 150px; animation-delay: 0s; animation-duration: 11s; }
        @keyframes animate {
            0% { transform: translateY(0) rotate(0deg); opacity: 1; border-radius: 0; }
            100% { transform: translateY(-1000px) rotate(720deg); opacity: 0; border-radius: 50%; }
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
            position: relative;
            z-index: 1;
        }
        
        /* Header Section */
        .hero {
            text-align: center;
            padding: 80px 20px;
            animation: fadeInDown 1s ease;
        }
        .hero-icon {
            font-size: 6em;
            color: white;
            margin-bottom: 20px;
            animation: float 3s ease-in-out infinite;
            text-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        .hero h1 {
            font-size: 4.5em;
            font-weight: 900;
            color: white;
            margin-bottom: 20px;
            text-shadow: 0 5px 25px rgba(0,0,0,0.3);
            letter-spacing: 2px;
        }
        .hero-subtitle {
            font-size: 1.5em;
            color: rgba(255,255,255,0.95);
            margin-bottom: 30px;
            text-shadow: 0 3px 15px rgba(0,0,0,0.2);
        }
        .hero-description {
            font-size: 1.1em;
            color: rgba(255,255,255,0.9);
            max-width: 600px;
            margin: 0 auto 40px;
            line-height: 1.6;
        }
        .cta-button {
            display: inline-block;
            background: white;
            color: #667eea;
            padding: 18px 50px;
            border-radius: 50px;
            text-decoration: none;
            font-weight: 700;
            font-size: 1.2em;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            transition: all 0.3s ease;
            animation: pulse 2s infinite;
        }
        .cta-button:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 40px rgba(0,0,0,0.4);
            background: linear-gradient(135deg, #fff, #f0f0f0);
        }
        
        /* Features Grid */
        .features {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 30px;
            margin: 60px 0;
            animation: fadeInUp 1s ease 0.3s both;
        }
        .feature-card {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 25px;
            padding: 40px;
            text-align: center;
            box-shadow: 0 15px 35px rgba(0,0,0,0.2);
            transition: all 0.4s ease;
            position: relative;
            overflow: hidden;
        }
        .feature-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: linear-gradient(135deg, rgba(102, 126, 234, 0.1), rgba(118, 75, 162, 0.1));
            opacity: 0;
            transition: opacity 0.3s ease;
        }
        .feature-card:hover {
            transform: translateY(-10px);
            box-shadow: 0 20px 50px rgba(0,0,0,0.3);
        }
        .feature-card:hover::before {
            opacity: 1;
        }
        .feature-icon {
            font-size: 3.5em;
            margin-bottom: 20px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            position: relative;
        }
        .feature-card h3 {
            font-size: 1.6em;
            color: #333;
            margin-bottom: 15px;
            font-weight: 700;
        }
        .feature-card p {
            color: #666;
            line-height: 1.6;
            font-size: 1.05em;
        }
        
        /* How It Works Section */
        .how-it-works {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 30px;
            padding: 60px 40px;
            margin: 60px 0;
            box-shadow: 0 20px 50px rgba(0,0,0,0.2);
            animation: fadeInUp 1s ease 0.6s both;
        }
        .how-it-works h2 {
            text-align: center;
            font-size: 3em;
            color: #667eea;
            margin-bottom: 50px;
            font-weight: 800;
        }
        .steps {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 40px;
        }
        .step {
            text-align: center;
            position: relative;
        }
        .step-number {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2em;
            font-weight: 800;
            color: white;
            margin: 0 auto 25px;
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
            transition: all 0.3s ease;
        }
        .step:hover .step-number {
            transform: scale(1.1) rotate(5deg);
        }
        .step h4 {
            font-size: 1.4em;
            color: #333;
            margin-bottom: 15px;
            font-weight: 700;
        }
        .step p {
            color: #666;
            line-height: 1.6;
        }
        
        /* Stats Section */
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 30px;
            margin: 60px 0;
            animation: fadeInUp 1s ease 0.9s both;
        }
        .stat-card {
            background: rgba(255, 255, 255, 0.95);
            border-radius: 20px;
            padding: 30px;
            text-align: center;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            transition: all 0.3s ease;
        }
        .stat-card:hover {
            transform: translateY(-5px);
        }
        .stat-number {
            font-size: 3em;
            font-weight: 900;
            background: linear-gradient(135deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 10px;
        }
        .stat-label {
            color: #666;
            font-size: 1.1em;
            font-weight: 600;
        }
        
        /* Footer */
        .footer {
            text-align: center;
            padding: 40px 20px;
            color: white;
            animation: fadeIn 1s ease 1.2s both;
        }
        .footer-links {
            margin: 20px 0;
        }
        .footer-links a {
            color: white;
            text-decoration: none;
            margin: 0 15px;
            font-weight: 600;
            transition: all 0.3s ease;
            display: inline-block;
        }
        .footer-links a:hover {
            transform: translateY(-2px);
            color: #ffd700;
            text-shadow: 0 0 10px rgba(255, 215, 0, 0.5);
        }
        .footer p {
            margin: 10px 0;
            font-size: 1.1em;
        }
        
        /* Animations */
        @keyframes fadeInDown {
            from { opacity: 0; transform: translateY(-50px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeInUp {
            from { opacity: 0; transform: translateY(50px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        @keyframes float {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-20px); }
        }
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }
        
        /* Responsive */
        @media (max-width: 768px) {
            .hero h1 { font-size: 2.5em; }
            .hero-subtitle { font-size: 1.2em; }
            .how-it-works h2 { font-size: 2em; }
            .features, .steps, .stats { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="bg-animation">
        <span></span><span></span><span></span><span></span><span></span>
        <span></span><span></span><span></span><span></span><span></span>
    </div>
    
    <div class="container">
        <div class="hero">
            <div class="hero-icon">
                <i class="fas fa-cloud-upload-alt"></i>
            </div>
            <h1>${BOT_NAME}</h1>
            <p class="hero-subtitle">⚡ Premium File Streaming & Download Service</p>
            <p class="hero-description">
                Transform your files into instant streaming links. Upload once, stream anywhere, anytime with blazing fast speeds powered by Cloudflare's global network.
            </p>
            <a href="https://t.me/${bot.username}" target="_blank" class="cta-button">
                <i class="fab fa-telegram"></i> Start Using Bot
            </a>
        </div>
        
        <div class="features">
            <div class="feature-card">
                <div class="feature-icon"><i class="fas fa-rocket"></i></div>
                <h3>Lightning Fast</h3>
                <p>Stream files instantly with Cloudflare's global CDN network. No buffering, no waiting, just pure speed.</p>
            </div>
            <div class="feature-card">
                <div class="feature-icon"><i class="fas fa-shield-halved"></i></div>
                <h3>Secure & Private</h3>
                <p>Your files are encrypted and stored securely. Revoke access anytime with secret tokens.</p>
            </div>
            <div class="feature-card">
                <div class="feature-icon"><i class="fas fa-mobile-screen"></i></div>
                <h3>Multi-Platform</h3>
                <p>Stream on any device - browser, VLC, MX Player, or download directly to your device.</p>
            </div>
            <div class="feature-card">
                <div class="feature-icon"><i class="fas fa-infinity"></i></div>
                <h3>Unlimited Bandwidth</h3>
                <p>No bandwidth limits, no throttling. Stream as much as you want, whenever you want.</p>
            </div>
            <div class="feature-card">
                <div class="feature-icon"><i class="fas fa-gauge-high"></i></div>
                <h3>High Quality</h3>
                <p>Support for files up to 4GB. Original quality preserved, no compression.</p>
            </div>
            <div class="feature-card">
                <div class="feature-icon"><i class="fas fa-share-nodes"></i></div>
                <h3>Easy Sharing</h3>
                <p>Share links instantly with anyone. Simple, fast, and hassle-free file sharing.</p>
            </div>
        </div>
        
        <div class="how-it-works">
            <h2><i class="fas fa-lightbulb"></i> How It Works</h2>
            <div class="steps">
                <div class="step">
                    <div class="step-number">1</div>
                    <h4>Send File to Bot</h4>
                    <p>Upload any media file to our Telegram bot - videos, audio, documents, images</p>
                </div>
                <div class="step">
                    <div class="step-number">2</div>
                    <h4>Get Instant Links</h4>
                    <p>Receive streaming and download links instantly with a revoke button for security</p>
                </div>
                <div class="step">
                    <div class="step-number">3</div>
                    <h4>Stream Anywhere</h4>
                    <p>Play in browser with our premium player, VLC, MX Player, or any device</p>
                </div>
                <div class="step">
                    <div class="step-number">4</div>
                    <h4>Share & Enjoy</h4>
                    <p>Share links with anyone, manage your files, and revoke access anytime</p>
                </div>
            </div>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-number"><i class="fas fa-bolt"></i></div>
                <div class="stat-label">Instant Streaming</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">4GB</div>
                <div class="stat-label">Max File Size</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">∞</div>
                <div class="stat-label">Bandwidth</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">24/7</div>
                <div class="stat-label">Availability</div>
            </div>
        </div>
        
        <div class="footer">
            <p style="font-size: 1.3em; margin-bottom: 20px;">
                <i class="fas fa-crown" style="color: #ffd700;"></i>
                Created with ❤️ by <a href="https://t.me/${OWNER_USERNAME}" style="color: #ffd700; text-decoration: none; font-weight: 700;" target="_blank">@${OWNER_USERNAME}</a>
            </p>
            <div class="footer-links">
                <a href="https://t.me/${bot.username}" target="_blank"><i class="fab fa-telegram"></i> Bot</a>
                <a href="https://t.me/${OWNER_USERNAME}" target="_blank"><i class="fas fa-user"></i> Contact</a>
                <a href="https://github.com/vauth/filestream-cf" target="_blank"><i class="fab fa-github"></i> Source</a>
            </div>
            <p style="opacity: 0.9; margin-top: 20px;">
                Powered by ${BOT_NAME} • Cloudflare Workers
            </p>
        </div>
    </div>
</body>
</html>`;
}

// ---------- UUID Generator ---------- //

async function UUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// ---------- Secure Hash Generator with HMAC-SHA256 ---------- //

class Cryptic {
  // Generate cryptographically secure random token
  static async generateRandomToken(length = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const randomValues = crypto.getRandomValues(new Uint8Array(length));
    let token = '';
    for (let i = 0; i < length; i++) {
        token += chars[randomValues[i] % chars.length];
    }
    return token;
  }

  // Generate HMAC-SHA256 signature
  static async hmacSHA256(message, secret) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(message);
    
    const key = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    
    const signature = await crypto.subtle.sign('HMAC', key, messageData);
    return this.arrayBufferToBase64(signature);
  }

  // Convert ArrayBuffer to Base64
  static arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  // Convert Base64 to ArrayBuffer
  static base64ToArrayBuffer(base64) {
    base64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Generate secure hash: random_token + message_id + HMAC(random_token:message_id, secret)
  static async Hash(text) {
    const randomToken = await this.generateRandomToken(12);
    const payload = `${randomToken}:${text}`;
    const signature = await this.hmacSHA256(payload, SIA_SECRET);
    // Format: randomToken.messageId.signature (URL-safe)
    return `${randomToken}.${text}.${signature.substring(0, 32)}`;
  }

  // Verify and extract message_id from hash
  static async deHash(hashed) {
    const parts = hashed.split('.');
    if (parts.length !== 3) {
        throw new Error('Invalid hash format');
    }
    
    const randomToken = parts[0];
    const messageId = parts[1];
    const providedSignature = parts[2];
    
    // Verify HMAC signature
    const payload = `${randomToken}:${messageId}`;
    const expectedSignature = (await this.hmacSHA256(payload, SIA_SECRET)).substring(0, 32);
    
    if (providedSignature !== expectedSignature) {
        throw new Error('Invalid signature - hash verification failed');
    }
    
    return messageId;
  }
}

// ---------- Telegram Bot ---------- //

class Bot {
  static async handleWebhook(request, env) {
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== BOT_SECRET) {
      return new Response('Unauthorized', { status: 403 })
    }
    const update = await request.json()
    // Process update asynchronously
    if (update.inline_query) {await onInline(request, env, update.inline_query)}
    if (update.callback_query) {await onCallback(request, env, update.callback_query)}
    if ('message' in update) {await onMessage(request, env, update.message)}
    return new Response('Ok')
  }

  static async registerWebhook(request, requestUrl, suffix, secret) {
    const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`
    const response = await fetch(await this.apiUrl('setWebhook', { url: webhookUrl, secret_token: secret }))
    return new Response(JSON.stringify(await response.json()), {headers: HEADERS_ERRR})
  }

  static async unregisterWebhook(request) { 
    const response = await fetch(await this.apiUrl('setWebhook', { url: '' }))
    return new Response(JSON.stringify(await response.json()), {headers: HEADERS_ERRR})
  }

  static async getMe() {
    const response = await fetch(await this.apiUrl('getMe'))
    if (response.status == 200) {return (await response.json()).result;
    } else {return await response.json()}
  }

  static async sendMessage(chat_id, reply_id, text, reply_markup=[]) {
    const response = await fetch(await this.apiUrl('sendMessage', {chat_id: chat_id, reply_to_message_id: reply_id, parse_mode: 'markdown', text, reply_markup: JSON.stringify({inline_keyboard: reply_markup})}))
    if (response.status == 200) {return (await response.json()).result;
    } else {return await response.json()}
  }

  static async editMessageText(chat_id, message_id, text, reply_markup=[]) {
    const response = await fetch(await this.apiUrl('editMessageText', {
        chat_id: chat_id,
        message_id: message_id,
        text: text,
        parse_mode: 'markdown',
        reply_markup: JSON.stringify({inline_keyboard: reply_markup})
    }))
    if (response.status == 200) {return (await response.json()).result;
    } else {return await response.json()}
  }

  static async sendDocument(chat_id, file_id) {
    const response = await fetch(await this.apiUrl('sendDocument', {chat_id: chat_id, document: file_id}))
    if (response.status == 200) {return (await response.json()).result;
    } else {return await response.json()}
  }

  static async sendPhoto(chat_id, file_id) {
    const response = await fetch(await this.apiUrl('sendPhoto', {chat_id: chat_id, photo: file_id}))
    if (response.status == 200) {return (await response.json()).result;
    } else {return await response.json()}
  }
  
  static async copyMessage(chat_id, from_chat_id, message_id, caption='') {
    const params = {
        chat_id: chat_id, 
        from_chat_id: from_chat_id, 
        message_id: message_id
    };
    // Only add caption if provided
    if (caption && caption.trim() !== '') {
        params.caption = caption;
    }
    const response = await fetch(await this.apiUrl('copyMessage', params));
    if (response.status == 200) {return (await response.json()).result;
    } else {return await response.json()}
  }

  static async editMessage(channel_id, message_id, caption_text) {
      const response = await fetch(await this.apiUrl('editMessageCaption', {chat_id: channel_id, message_id: message_id, caption: caption_text}))
      if (response.status == 200) {return (await response.json()).result;
      } else {return await response.json()}
  }
  
  static async deleteMessage(chat_id, message_id) {
      const response = await fetch(await this.apiUrl('deleteMessage', {chat_id: chat_id, message_id: message_id}))
      if (response.status == 200) {return (await response.json()).result;
      } else {return await response.json()}
  }

  static async answerCallbackQuery(callback_id, text, show_alert = false) {
    const response = await fetch(await this.apiUrl('answerCallbackQuery', {
        callback_query_id: callback_id,
        text: text,
        show_alert: show_alert
    }))
    if (response.status == 200) {return (await response.json()).result;
    } else {return await response.json()}
  }

  static async answerInlineArticle(query_id, title, description, text, reply_markup=[], id='1') {
    const data = [{type: 'article', id: id, title: title, thumbnail_url: "https://i.ibb.co/5s8hhND/dac5fa134448.png", description: description, input_message_content: {message_text: text, parse_mode: 'markdown'}, reply_markup: {inline_keyboard: reply_markup}}];
    const response = await fetch(await this.apiUrl('answerInlineQuery', {inline_query_id: query_id, results: JSON.stringify(data), cache_time: 1}))
    if (response.status == 200) {return (await response.json()).result;
    } else {return await response.json()}
  }

  static async answerInlineDocument(query_id, title, file_id, mime_type, reply_markup=[], id='1') {
    const data = [{type: 'document', id: id, title: title, document_file_id: file_id, mime_type: mime_type, description: mime_type, reply_markup: {inline_keyboard: reply_markup}}];
    const response = await fetch(await this.apiUrl('answerInlineQuery', {inline_query_id: query_id, results: JSON.stringify(data), cache_time: 1}))
    if (response.status == 200) {return (await response.json()).result;
    } else {return await response.json()}
  }

  static async answerInlinePhoto(query_id, title, photo_id, reply_markup=[], id='1') {
    const data = [{type: 'photo', id: id, title: title, photo_file_id: photo_id, reply_markup: {inline_keyboard: reply_markup}}];
    const response = await fetch(await this.apiUrl('answerInlineQuery', {inline_query_id: query_id, results: JSON.stringify(data), cache_time: 1}))
    if (response.status == 200) {return (await response.json()).result;
    } else {return await response.json()}
  }

  static async getFile(file_id) {
      const response = await fetch(await this.apiUrl('getFile', {file_id: file_id}))
      if (response.status == 200) {return (await response.json()).result;
      } else {return await response.json()}
  }

  static async fetchFile(file_path) {
      const file = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file_path}`);
      return await file.arrayBuffer()
  }

  static async apiUrl (methodName, params = null) {
      let query = ''
      if (params) {query = '?' + new URLSearchParams(params).toString()}
      return `https://api.telegram.org/bot${BOT_TOKEN}/${methodName}${query}`
  }
}

// ---------- Callback Query Handler ---------- // 

async function onCallback(request, env, callback) {
    const data = callback.data;
    const chatId = callback.message.chat.id;
    const messageId = callback.message.message_id;
    const userId = callback.from.id;
    
    // Handle revoke button
    if (data.startsWith('revoke_')) {
        const token = data.replace('revoke_', '');
        
        // Check if database is available
        if (!env || !env.DB) {
            return Bot.answerCallbackQuery(callback.id, "❌ Database not configured", true);
        }
        
        const fileData = await DB.getFileByToken(env.DB, token);
        
        if (!fileData) {
            return Bot.answerCallbackQuery(callback.id, "❌ File not found or already deleted", true);
        }
        
        // Check if user owns this file or is owner
        if (fileData.user_id != userId && userId != BOT_OWNER) {
            return Bot.answerCallbackQuery(callback.id, "❌ You don't have permission to revoke this file", true);
        }
        
        // Delete from channel
        await Bot.deleteMessage(BOT_CHANNEL, fileData.message_id);
        
        // Delete from database
        await DB.deleteFile(env.DB, fileData.message_id);
        
        // Edit the message
        await Bot.editMessageText(chatId, messageId, "🗑️ *ғɪʟᴇ ʀᴇᴠᴏᴋᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ!*\n\nAll links have been deleted and the file is no longer accessible.", []);
        
        return Bot.answerCallbackQuery(callback.id, "✅ File revoked successfully!", false);
    }
    
    // Handle file view from /files command
    if (data.startsWith('view_')) {
        const fileId = data.replace('view_', '');
        
        if (!env || !env.DB) {
            return Bot.answerCallbackQuery(callback.id, "❌ Database not configured", true);
        }
        
        const fileData = await DB.getFile(env.DB, fileId);
        
        if (!fileData) {
            return Bot.answerCallbackQuery(callback.id, "❌ File not found", true);
        }
        
        // Generate links
        const url = new URL(request.url);
        const final_hash = await Cryptic.Hash(fileData.message_id);
        const stream_page = `${url.origin}/streampage?file=${final_hash}`;
        const stream_link = `${url.origin}/stream/${final_hash}`;
        const download_link = `${url.origin}/dl/${final_hash}`;
        const telegram_link = `https://t.me/${(await Bot.getMe()).username}/?start=${final_hash}`;
        
        const safeName = escapeMarkdown(fileData.file_name);
        const formattedSize = formatSize(fileData.file_size);
        
        // Buttons with revoke option
        const buttons = [
            [
                { text: "🌐 sᴛʀᴇᴀᴍ ᴘᴀɢᴇ", url: stream_page },
                { text: "📥 ᴅᴏᴡɴʟᴏᴀᴅ", url: download_link }
            ],
            [
                { text: "💬 ᴛᴇʟᴇɢʀᴀᴍ", url: telegram_link },
                { text: "🔁 sʜᴀʀᴇ", switch_inline_query: final_hash }
            ],
            [
                { text: "🗑️ ʀᴇᴠᴏᴋᴇ ᴀᴄᴄᴇss", callback_data: `revoke_${fileData.secret_token}` }
            ],
            [
                { text: "⬅️ ʙᴀᴄᴋ ᴛᴏ ʟɪsᴛ", callback_data: "back_to_files" }
            ]
        ];
        
        let messageText = `✅ *ғɪʟᴇ ᴅᴇᴛᴀɪʟs*\n\n` +
            `📂 *ғɪʟᴇ ɴᴀᴍᴇ:* \`${safeName}\`\n` +
            `💾 *ғɪʟᴇ sɪᴢᴇ:* \`${formattedSize}\`\n` +
            `📊 *ғɪʟᴇ ᴛʏᴘᴇ:* \`${fileData.file_type}\`\n` +
            `📥 *ᴅᴏᴡɴʟᴏᴀᴅs:* \`${fileData.downloads || 0}\`\n` +
            `📅 *ᴜᴘʟᴏᴀᴅᴇᴅ:* \`${new Date(fileData.created_at).toLocaleDateString()}\`\n\n` +
            `🔗 *sᴛʀᴇᴀᴍ ʟɪɴᴋ:*\n\`${stream_link}\``;
        
        await Bot.editMessageText(chatId, messageId, messageText, buttons);
        return Bot.answerCallbackQuery(callback.id, "📂 File details loaded", false);
    }
    
    // Handle back to files list
    if (data === 'back_to_files') {
        if (!env || !env.DB) {
            return Bot.answerCallbackQuery(callback.id, "❌ Database not configured", true);
        }
        
        const userFiles = await DB.getUserFiles(env.DB, userId.toString());
        
        if (userFiles.length === 0) {
            await Bot.editMessageText(chatId, messageId, "📂 *ʏᴏᴜʀ ғɪʟᴇs*\n\nYou don't have any files yet. Send me a file to get started!", []);
            return Bot.answerCallbackQuery(callback.id, "No files found", false);
        }
        
        let buttons = userFiles.slice(0, 10).map(file => {
            const fileName = file.file_name.length > 30 ? file.file_name.substring(0, 27) + '...' : file.file_name;
            return [{ text: `📄 ${fileName}`, callback_data: `view_${file.message_id}` }];
        });
        
        let messageText = `📂 *ʏᴏᴜʀ ғɪʟᴇs* (${userFiles.length} total)\n\nClick on any file to view details and get links:`;
        
        await Bot.editMessageText(chatId, messageId, messageText, buttons);
        return Bot.answerCallbackQuery(callback.id, "📂 Files list loaded", false);
    }
    
    return Bot.answerCallbackQuery(callback.id, "Action processed", false);
}

// ---------- Inline Listener ---------- // 

async function onInline(request, env, inline) {
  let  fID; let fName; let fType; let fSize; let fLen;

  if (!PUBLIC_BOT && inline.from.id != BOT_OWNER) {
    const buttons = [[{ text: "Source Code", url: "https://t.me/FLiX_LY" }]];
    return await Bot.answerInlineArticle(inline.id, "Access forbidden", "Deploy your own filestream-cf.", "*❌ ᴀᴄᴄᴇss ғᴏʀʙɪᴅᴅᴇɴ.*\n📡 Deploy your own [filestream-cf](https://github.com/vauth/filestream-cf) bot.", buttons)
  }
 
  try {await Cryptic.deHash(inline.query)} catch {
    const buttons = [[{ text: "Source Code", url: "https://github.com/vauth/filestream-cf" }]];
    return await Bot.answerInlineArticle(inline.id, "Error", ERROR_407.description, ERROR_407.description, buttons)
  }

  const channel_id = BOT_CHANNEL;
  const message_id = await Cryptic.deHash(inline.query);
  const data = await Bot.editMessage(channel_id, message_id, await UUID());

  if (data.error_code){
    const buttons = [[{ text: "Source Code", url: "https://t.me/FLiX_LY" }]];
    return await Bot.answerInlineArticle(inline.id, "Error", data.description, data.description, buttons)
  }

  if (data.document){
    fLen = data.document.length - 1
    fID = data.document.file_id;
    fName = data.document.file_name;
    fType = data.document.mime_type;
    fSize = data.document.file_size;
  } else if (data.audio) {
    fLen = data.audio.length - 1
    fID = data.audio.file_id;
    fName = data.audio.file_name;
    fType = data.audio.mime_type;
    fSize = data.audio.file_size;
  } else if (data.video) {
    fLen = data.video.length - 1
    fID = data.video.file_id;
    fName = data.video.file_name;
    fType = data.video.mime_type;
    fSize = data.video.file_size;
  } else if (data.photo) {
    fLen = data.photo.length - 1
    fID = data.photo[fLen].file_id;
    fName = data.photo[fLen].file_unique_id + '.jpg';
    fType = "image/jpg";
    fSize = data.photo[fLen].file_size;
  } else {
    return ERROR_406
  }

  if (fType == "image/jpg") {
    const buttons = [[{ text: "Send Again", switch_inline_query_current_chat: inline.query }]]
    return await Bot.answerInlinePhoto(inline.id, fName || "undefined", fID, buttons)
  } else {
    const buttons = [[{ text: "Send Again", switch_inline_query_current_chat: inline.query }]];
    return await Bot.answerInlineDocument(inline.id, fName || "undefined", fID, fType, buttons)
  }

}

// ---------- Message Listener ---------- // 

async function onMessage(request, env, message) {
    let fID; let fName; let fSave; let fType; let fSize = 0;
    let url = new URL(request.url);
    let bot = await Bot.getMe();

    // 1. Ignore messages from the bot itself
    if (message.via_bot && message.via_bot.username == bot.username) { return }

    // 2. Ignore messages from channels
    if (message.chat.id.toString().includes("-100")) { return }

    // 3. Handle Start Command
    if (message.text && (message.text === "/start" || message.text.startsWith("/start "))) {
        // Plain start
        if (message.text === "/start") {
             const buttons = [[{ text: "👨‍💻 Source Code", url: "https://t.me/FLiX_LY" }]];
             const startText = `👋 *ʜᴇʟʟᴏ ${message.from.first_name}*,\n\nI am a *ᴘʀᴇᴍɪᴜᴍ ғɪʟᴇ sᴛʀᴇᴀᴍ ʙᴏᴛ*.\n\n📂 *Send me any file* (Video, Audio, Document) and I will generate a direct download and streaming link for you.\n\n*ᴄᴏᴍᴍᴀɴᴅs:*\n/files - View all your files\n/revoke <token> - Revoke a file\n/stats - View statistics (Owner only)\n/revokeall - Delete all files (Owner only)`;
             return Bot.sendMessage(message.chat.id, message.message_id, startText, buttons);
        }

        // Deep linking start
        const file = message.text.split("/start ")[1];
        if (!file) return; 

        try { await Cryptic.deHash(file) } catch { return await Bot.sendMessage(message.chat.id, message.message_id, ERROR_407.description) }

        const channel_id = BOT_CHANNEL;
        const message_id = await Cryptic.deHash(file);
        const data = await Bot.editMessage(channel_id, message_id, await UUID());

        if (data.document) {
            fID = data.document.file_id;
            return await Bot.sendDocument(message.chat.id, fID)
        } else if (data.audio) {
            fID = data.audio.file_id;
            return await Bot.sendDocument(message.chat.id, fID)
        } else if (data.video) {
            fID = data.video.file_id;
            return await Bot.sendDocument(message.chat.id, fID)
        } else if (data.photo) {
            fID = data.photo[data.photo.length - 1].file_id;
            return await Bot.sendPhoto(message.chat.id, fID)
        } else {
            return Bot.sendMessage(message.chat.id, message.message_id, "Bad Request: File not found")
        }
    }
    
    // 4. Handle /files command
    if (message.text === '/files') {
        if (!env || !env.DB) {
            return Bot.sendMessage(message.chat.id, message.message_id, "❌ Database not configured. Please set up D1 database.");
        }
        
        const userId = message.from.id.toString();
        const userFiles = await DB.getUserFiles(env.DB, userId);
        
        if (userFiles.length === 0) {
            return Bot.sendMessage(message.chat.id, message.message_id, "📂 *ʏᴏᴜʀ ғɪʟᴇs*\n\nYou don't have any files yet. Send me a file to get started!");
        }
        
        let buttons = userFiles.slice(0, 10).map(file => {
            const fileName = file.file_name.length > 30 ? file.file_name.substring(0, 27) + '...' : file.file_name;
            return [{ text: `📄 ${fileName}`, callback_data: `view_${file.message_id}` }];
        });
        
        let messageText = `📂 *ʏᴏᴜʀ ғɪʟᴇs* (${userFiles.length} total)\n\nClick on any file to view details and get links:`;
        
        return Bot.sendMessage(message.chat.id, message.message_id, messageText, buttons);
    }
    
    // 5. Handle /revoke command
    if (message.text && message.text.startsWith('/revoke ')) {
        const token = message.text.split('/revoke ')[1];
        
        if (!token) {
            return Bot.sendMessage(message.chat.id, message.message_id, "❌ *ɪɴᴠᴀʟɪᴅ ᴄᴏᴍᴍᴀɴᴅ*\n\nUsage: `/revoke <secret_token>`");
        }
        
        if (!env || !env.DB) {
            return Bot.sendMessage(message.chat.id, message.message_id, "❌ Database not configured.");
        }
        
        const fileData = await DB.getFileByToken(env.DB, token);
        
        if (!fileData) {
            return Bot.sendMessage(message.chat.id, message.message_id, "❌ *ғɪʟᴇ ɴᴏᴛ ғᴏᴜɴᴅ*\n\nThe file with this token doesn't exist or has already been deleted.");
        }
        
        // Check if user owns this file or is owner
        if (fileData.user_id != message.from.id && message.from.id != BOT_OWNER) {
            return Bot.sendMessage(message.chat.id, message.message_id, "❌ *ᴘᴇʀᴍɪssɪᴏɴ ᴅᴇɴɪᴇᴅ*\n\nYou don't have permission to revoke this file.");
        }
        
        // Delete from channel
        await Bot.deleteMessage(BOT_CHANNEL, fileData.message_id);
        
        // Delete from database
        await DB.deleteFile(env.DB, fileData.message_id);
        
        return Bot.sendMessage(message.chat.id, message.message_id, 
            `🗑️ *ғɪʟᴇ ʀᴇᴠᴏᴋᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ!*\n\n` +
            `📂 *ғɪʟᴇ:* \`${escapeMarkdown(fileData.file_name)}\`\n\n` +
            `All links have been deleted and the file is no longer accessible.`
        );
    }
    
    // 6. Handle /revokeall command (owner only)
    if (message.text === '/revokeall') {
        if (message.from.id != BOT_OWNER) {
            return Bot.sendMessage(message.chat.id, message.message_id, "❌ *ᴘᴇʀᴍɪssɪᴏɴ ᴅᴇɴɪᴇᴅ*\n\nThis command is only available to the bot owner.");
        }
        
        if (!env || !env.DB) {
            return Bot.sendMessage(message.chat.id, message.message_id, "❌ Database not configured.");
        }
        
        // Get all files
        const allFiles = await env.DB.prepare('SELECT * FROM files').all();
        
        if (!allFiles.results || allFiles.results.length === 0) {
            return Bot.sendMessage(message.chat.id, message.message_id, "📂 No files to delete.");
        }
        
        // Delete all files from channel
        for (const file of allFiles.results) {
            try {
                await Bot.deleteMessage(BOT_CHANNEL, file.message_id);
            } catch (e) {
                console.log(`Failed to delete message ${file.message_id}`);
            }
        }
        
        // Delete all from database
        await DB.deleteAllFiles(env.DB);
        
        return Bot.sendMessage(message.chat.id, message.message_id, 
            `🗑️ *ᴀʟʟ ғɪʟᴇs ᴅᴇʟᴇᴛᴇᴅ!*\n\n` +
            `Deleted ${allFiles.results.length} files from the database and channel.`
        );
    }
    
    // 7. Handle /stats command (owner only)
    if (message.text === '/stats') {
        if (message.from.id != BOT_OWNER) {
            return Bot.sendMessage(message.chat.id, message.message_id, "❌ *ᴘᴇʀᴍɪssɪᴏɴ ᴅᴇɴɪᴇᴅ*\n\nThis command is only available to the bot owner.");
        }
        
        if (!env || !env.DB) {
            return Bot.sendMessage(message.chat.id, message.message_id, "❌ Database not configured.");
        }
        
        const stats = await DB.getStats(env.DB);
        
        return Bot.sendMessage(message.chat.id, message.message_id,
            `📊 *ʙᴏᴛ sᴛᴀᴛɪsᴛɪᴄs*\n\n` +
            `📂 *ᴛᴏᴛᴀʟ ғɪʟᴇs:* \`${stats.totalFiles}\`\n` +
            `👥 *ᴛᴏᴛᴀʟ ᴜsᴇʀs:* \`${stats.totalUsers}\`\n` +
            `📥 *ᴛᴏᴛᴀʟ ᴅᴏᴡɴʟᴏᴀᴅs:* \`${stats.totalDownloads}\``
        );
    }

    // 8. Access Control
    if (!PUBLIC_BOT && message.chat.id != BOT_OWNER) {
        const buttons = [[{ text: "Source Code", url: "https://t.me/FLiX_LY" }]];
        return Bot.sendMessage(message.chat.id, message.message_id, "*❌ ᴀᴄᴄᴇss ғᴏʀʙɪᴅᴅᴇɴ.*\n📡 Deploy your own [filestream-cf](https://t.me/FLiX_LY) bot.", buttons)
    }

    // 9. Detect File Type & Copy to Channel
    if (message.document || message.audio || message.video || message.photo) {
        
        // --- 9a. Extract Metadata ---
        if (message.document) {
            fName = message.document.file_name || "Document";
            fType = message.document.mime_type ? message.document.mime_type.split("/")[0] : "document";
            fSize = message.document.file_size;
        } else if (message.audio) {
            fName = message.audio.file_name || "Audio File";
            fType = message.audio.mime_type ? message.audio.mime_type.split("/")[0] : "audio";
            fSize = message.audio.file_size;
        } else if (message.video) {
            fName = message.video.file_name || "Video File";
            fType = message.video.mime_type ? message.video.mime_type.split("/")[0] : "video";
            fSize = message.video.file_size;
        } else if (message.photo) {
            const uniqueId = message.photo[message.photo.length - 1].file_unique_id;
            fName = `${uniqueId}.jpg`;
            fType = "image";
            fSize = message.photo[message.photo.length - 1].file_size;
        }

        // --- 9b. Size Check ---
        if (fSize > MAX_TELEGRAM_SIZE) {
            return Bot.sendMessage(message.chat.id, message.message_id, 
                `❌ *ғɪʟᴇ ᴛᴏᴏ ʟᴀʀɢᴇ*\n\n` +
                `📊 *ғɪʟᴇ sɪᴢᴇ:* \`${formatSize(fSize)}\`\n` +
                `⚠️ *ᴍᴀx ᴀʟʟᴏᴡᴇᴅ:* \`4.00 GB\`\n\n` +
                `Please send a smaller file.`);
        }

        // --- 9c. Copy the Message to Channel (no caption to avoid parsing issues) ---
        fSave = await Bot.copyMessage(BOT_CHANNEL, message.chat.id, message.message_id, '');
        
        // --- 9d. Send a Reply Message in Channel with User Info ---
        if (fSave && fSave.message_id) {
            const userName = message.from.username ? `@${message.from.username}` : message.from.first_name;
            const userInfoText = `RᴇQᴜᴇꜱᴛᴇᴅ ʙʏ : ${userName}\nUꜱᴇʀ ɪᴅ : ${message.from.id}\nFɪʟᴇ ɴᴀᴍᴇ : ${fName}`;
            await Bot.sendMessage(BOT_CHANNEL, fSave.message_id, userInfoText, []);
        }

    } else {
        const buttons = [[{ text: "Source Code", url: "https://github.com/vauth/filestream-cf" }]];
        return Bot.sendMessage(message.chat.id, message.message_id, "Send me any file/video/gif/audio *(max 4GB)*.", buttons)
    }

    // 10. Check if Forwarding Failed
    if (fSave.error_code) {
        return Bot.sendMessage(message.chat.id, message.message_id, "❌ Error forwarding to channel:\n" + fSave.description);
    }

    // 11. Generate Links & Buttons
    try {
        if (!fSave.message_id) {
            return Bot.sendMessage(message.chat.id, message.message_id, "❌ Error: Channel did not return a message ID.");
        }

        const final_hash = await Cryptic.Hash(fSave.message_id);
        const stream_page = `${url.origin}/streampage?file=${final_hash}`;
        const stream_link = `${url.origin}/stream/${final_hash}`;
        const download_link = `${url.origin}/dl/${final_hash}`;
        const telegram_link = `https://t.me/${bot.username}/?start=${final_hash}`;
        const formattedSize = formatSize(fSize);
        
        // Generate secret token
        const secretToken = await generateSecretToken();
        
        // Save to database if available
        if (env && env.DB) {
            await DB.initDB(env.DB);
            await DB.registerUser(env.DB, {
                user_id: message.from.id.toString(),
                username: message.from.username || '',
                first_name: message.from.first_name || '',
                last_name: message.from.last_name || ''
            });
            await DB.addFile(env.DB, {
                file_id: final_hash,
                message_id: fSave.message_id.toString(),
                user_id: message.from.id.toString(),
                username: message.from.username || '',
                file_name: fName,
                file_size: fSize,
                file_type: fType,
                secret_token: secretToken
            });
        }
        
        // Determine if file is streamable (Video or Audio)
        const isStreamable = (fType === 'video' || fType === 'audio');

        // --- Define Buttons ---
        const btnStream = { text: "🌐 sᴛʀᴇᴀᴍ ᴘᴀɢᴇ", url: stream_page };
        const btnDownload = { text: "📥 ᴅᴏᴡɴʟᴏᴀᴅ", url: download_link };
        const btnTele = { text: "💬 ᴛᴇʟᴇɢʀᴀᴍ", url: telegram_link };
        const btnShare = { text: "🔁 sʜᴀʀᴇ", switch_inline_query: final_hash };
        const btnRevoke = { text: "🗑️ ʀᴇᴠᴏᴋᴇ", callback_data: `revoke_${secretToken}` };
        const btnOwner = { text: "👑 ᴏᴡɴᴇʀ", url: `https://t.me/${OWNER_USERNAME}` };

        let buttons = [];

        if (isStreamable) {
            buttons = [
                [btnStream, btnDownload],
                [btnTele, btnShare],
                [btnRevoke],
                [btnOwner]
            ];
        } else {
            // If it's a document/zip/exe, don't show Stream button
            buttons = [
                [btnDownload, btnTele],
                [btnShare],
                [btnRevoke],
                [btnOwner]
            ];
        }

        // --- Define Message Text ---
        const safeName = escapeMarkdown(fName);
        
        let final_text = `✅ *ғɪʟᴇ sᴜᴄᴄᴇssғᴜʟʟʏ ᴘʀᴏᴄᴇssᴇᴅ!*\n\n` +
            `📂 *ғɪʟᴇ ɴᴀᴍᴇ:* \`${safeName}\`\n` +
            `💾 *ғɪʟᴇ sɪᴢᴇ:* \`${formattedSize}\`\n` +
            `📊 *ғɪʟᴇ ᴛʏᴘᴇ:* \`${fType}\`\n` +
            `🔐 *sᴇᴄʀᴇᴛ ᴛᴏᴋᴇɴ:* \`${secretToken}\`\n`;

        if (isStreamable) {
            final_text += `🎬 *sᴛʀᴇᴀᴍɪɴɢ:* \`Available\`\n\n`;
            final_text += `🔗 *sᴛʀᴇᴀᴍ ʟɪɴᴋ:*\n\`${stream_link}\``;
            
            if (fSize > MAX_STREAM_SIZE) {
                final_text += `\n\n⚠️ *ɴᴏᴛᴇ:* Streaming works best for files under 2GB.`;
            }
        } else {
            final_text += `\n🔗 *ᴅᴏᴡɴʟᴏᴀᴅ ʟɪɴᴋ:*\n\`${download_link}\``;
        }
        
        final_text += `\n\n💡 *ᴛɪᴘ:* Use /revoke ${secretToken} to delete this file anytime.`;

        return Bot.sendMessage(message.chat.id, message.message_id, final_text, buttons);

    } catch (error) {
        return Bot.sendMessage(message.chat.id, message.message_id, "❌ **Critical Error:**\n" + error.message);
    }
}
