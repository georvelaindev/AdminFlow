const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const express = require('express');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.ADMINFLOW_DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.resolve(process.env.ADMINFLOW_UPLOAD_DIR || path.join(__dirname, 'uploads'));
const SESSION_COOKIE = 'adminflow_session';
const SESSION_DURATION = 8 * 60 * 60 * 1000;
const MAX_UPLOAD_SIZE = 15 * 1024 * 1024;
const DOCUMENT_CATEGORIES = new Set(['Note de service', 'Procès-Verbal', 'Rapport', 'Attestation']);
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
const roles = {
    dg: 'Directeur Général',
    de: 'Directeur des Études',
    scolarite: 'Chef de Scolarité',
    admin: 'Chef du système informatique',
    secretariat: 'Secrétariat Général'
};
const announcementRoles = new Set(['dg', 'de', 'scolarite', 'admin', 'secretariat']);
const loginAttempts = new Map();
const eventClients = new Set();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Initialise le schéma SQLite et applique les migrations nécessaires.
const db = new DatabaseSync(path.join(DATA_DIR, 'adminflow.sqlite'));
db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('dg', 'de', 'scolarite', 'admin', 'secretariat')),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        sender_id INTEGER NOT NULL REFERENCES users(id),
        receiver_role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'En cours',
        notes TEXT NOT NULL DEFAULT '',
        file_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS document_history (
        id INTEGER PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        step TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id),
        receiver_role TEXT NOT NULL,
        student TEXT NOT NULL,
        object TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'En attente',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY,
        author_id INTEGER NOT NULL REFERENCES users(id),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'GÉNÉRAL',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id),
        receiver_role TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS hidden_messages (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS hidden_requests (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS hidden_announcements (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, announcement_id)
    );
    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TRIGGER IF NOT EXISTS users_one_active_account_per_role_insert
    BEFORE INSERT ON users
    WHEN NEW.is_active = 1 AND EXISTS (
        SELECT 1 FROM users WHERE role = NEW.role AND is_active = 1
    )
    BEGIN
        SELECT RAISE(ABORT, 'active_role_already_assigned');
    END;
    CREATE TRIGGER IF NOT EXISTS users_one_active_account_per_role_update
    BEFORE UPDATE OF role, is_active ON users
    WHEN NEW.is_active = 1 AND EXISTS (
        SELECT 1 FROM users WHERE role = NEW.role AND is_active = 1 AND id != NEW.id
    )
    BEGIN
        SELECT RAISE(ABORT, 'active_role_already_assigned');
    END;
`);
if (
    !db
        .prepare('PRAGMA table_info(users)')
        .all()
        .some((column) => column.name === 'is_active')
) {
    db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))');
}

// Configure les en-têtes HTTP, le JSON et les ressources statiques.
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    next();
});
app.use(express.json({ limit: '100kb' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/script.js', (_req, res) => res.sendFile(path.join(__dirname, 'script.js')));
app.get('/style.css', (_req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/tailwind.generated.css', (_req, res) =>
    res.sendFile(path.join(__dirname, 'tailwind.generated.css'))
);
app.get('/logo-ipto.jpg', (_req, res) => res.sendFile(path.join(__dirname, 'logo-ipto.jpg')));
app.get('/batiment-principal.jpg', (_req, res) =>
    res.sendFile(path.join(__dirname, 'batiment-principal.jpg'))
);
app.get('/ipo.jpeg', (_req, res) => res.sendFile(path.join(__dirname, 'ipo.jpeg')));
app.get('/vendor/fontawesome/css/all.min.css', (_req, res) =>
    res.sendFile(
        path.join(__dirname, 'node_modules', '@fortawesome', 'fontawesome-free', 'css', 'all.min.css')
    )
);
app.get('/vendor/fontawesome/webfonts/:file', (req, res) => {
    const fontFiles = new Set(['fa-solid-900.woff2', 'fa-regular-400.woff2', 'fa-brands-400.woff2']);
    if (!fontFiles.has(req.params.file)) return fail(res, 404, 'Ressource introuvable.');
    res.sendFile(
        path.join(__dirname, 'node_modules', '@fortawesome', 'fontawesome-free', 'webfonts', req.params.file)
    );
});
db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());

const upload = multer({
    storage: multer.diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req, _file, callback) => callback(null, crypto.randomUUID())
    }),
    limits: { fileSize: MAX_UPLOAD_SIZE, files: 1, fields: 8, parts: 10, fieldSize: 10 * 1024 },
    fileFilter: (_req, file, callback) => {
        const allowed = new Set([
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/octet-stream'
        ]);
        const extension = path.extname(file.originalname).toLowerCase();
        if (!allowed.has(file.mimetype) || !['.pdf', '.doc', '.docx'].includes(extension)) {
            callback(new Error('Format non accepté. Utilisez un fichier PDF, DOC ou DOCX.'));
            return;
        }
        callback(null, true);
    }
});

// Helpers de réponse, de validation et de notifications.
function fail(res, status, message) {
    return res.status(status).json({ error: message });
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
}

function validPassword(password) {
    return typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password, 'utf8') <= 72;
}

function publicUser(user) {
    return { id: user.id, name: user.name, email: user.email, role: user.role, roleName: roles[user.role] };
}

function createNotification(userId, title, body) {
    db.prepare('INSERT INTO notifications (user_id, title, body) VALUES (?, ?, ?)').run(userId, title, body);
    publish('refresh', { userId });
}

function createRoleNotifications(role, title, body, exceptUserId = null) {
    const users = db.prepare('SELECT id FROM users WHERE role = ? AND is_active = 1').all(role);
    for (const user of users) {
        if (user.id !== exceptUserId) createNotification(user.id, title, body);
    }
}

function publish(type, payload) {
    const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of eventClients) {
        if (!payload.userId || payload.userId === client.userId) client.response.write(data);
    }
}

// Résout la session associée au cookie de la requête.
function getUserFromRequest(req) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = db
        .prepare(
            `
        SELECT users.id, users.name, users.email, users.role
        FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.is_active = 1
    `
        )
        .get(tokenHash, Date.now());
    return session || null;
}

app.use((req, _res, next) => {
    const cookieHeader = req.headers.cookie || '';
    const tokenCookie = cookieHeader
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    req.cookies = {};
    if (tokenCookie) {
        try {
            req.cookies[SESSION_COOKIE] = decodeURIComponent(tokenCookie.slice(SESSION_COOKIE.length + 1));
        } catch {
            req.cookies[SESSION_COOKIE] = '';
        }
    }
    req.user = getUserFromRequest(req);
    next();
});

function requireAuth(req, res, next) {
    if (!req.user) return fail(res, 401, 'Veuillez vous connecter.');
    next();
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) return fail(res, 401, 'Veuillez vous connecter.');
        if (!allowedRoles.includes(req.user.role))
            return fail(res, 403, 'Vous n’avez pas les droits nécessaires.');
        next();
    };
}

function requireSameOrigin(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
        return fail(res, 403, 'Origine de requête refusée.');
    }
    next();
}

app.use('/api', requireSameOrigin);

// Routes d'initialisation, de connexion et de gestion des sessions.
app.get('/api/status', (_req, res) => {
    res.json({ setupRequired: db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0 });
});

app.post('/api/setup', async (req, res, next) => {
    let transactionStarted = false;
    try {
        const name = cleanText(req.body.name, 100);
        const email = cleanText(req.body.email, 254).toLowerCase();
        const password = req.body.password;
        if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !validPassword(password)) {
            return fail(
                res,
                400,
                'Indiquez un nom, une adresse e-mail valide et un mot de passe de 12 caractères minimum (72 octets maximum).'
            );
        }
        const hash = await bcrypt.hash(password, 12);
        db.exec('BEGIN IMMEDIATE');
        transactionStarted = true;
        if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count !== 0) {
            db.exec('ROLLBACK');
            transactionStarted = false;
            return fail(res, 409, 'Le compte administrateur initial existe déjà.');
        }
        const result = db
            .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
            .run(name, email, hash, 'admin');
        db.exec('COMMIT');
        transactionStarted = false;
        const user = db
            .prepare('SELECT id, name, email, role FROM users WHERE id = ?')
            .get(result.lastInsertRowid);
        issueSession(res, user.id);
        res.status(201).json({ user: publicUser(user) });
    } catch (error) {
        if (transactionStarted) db.exec('ROLLBACK');
        next(error);
    }
});

function issueSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = Date.now() + SESSION_DURATION;
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
        tokenHash,
        userId,
        expiresAt
    );
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION / 1000}${secure}`
    );
}

app.post('/api/login', async (req, res, next) => {
    try {
        const address = req.ip || 'unknown';
        const attempt = loginAttempts.get(address) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
        if (attempt.until < Date.now()) {
            attempt.count = 0;
            attempt.until = Date.now() + 15 * 60 * 1000;
        }
        if (attempt.count >= 10)
            return fail(res, 429, 'Trop de tentatives. Réessayez dans quelques minutes.');
        const email = cleanText(req.body.email, 254).toLowerCase();
        const password = typeof req.body.password === 'string' ? req.body.password : '';
        const user = db
            .prepare('SELECT id, name, email, role, password_hash, is_active FROM users WHERE email = ?')
            .get(email);
        const passwordMatches = await bcrypt.compare(password, user?.password_hash || DUMMY_PASSWORD_HASH);
        if (!user || !user.is_active || !passwordMatches) {
            attempt.count += 1;
            loginAttempts.set(address, attempt);
            return fail(res, 401, 'Adresse e-mail ou mot de passe incorrect.');
        }
        loginAttempts.delete(address);
        issueSession(res, user.id);
        res.json({ user: publicUser(user) });
    } catch (error) {
        next(error);
    }
});

app.post('/api/logout', requireAuth, (req, res) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token)
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(
            crypto.createHash('sha256').update(token).digest('hex')
        );
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
    res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/password', requireAuth, async (req, res, next) => {
    try {
        const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
        const newPassword = req.body.newPassword;
        const record = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
        if (!record || !(await bcrypt.compare(currentPassword, record.password_hash)))
            return fail(res, 400, 'Le mot de passe actuel est incorrect.');
        if (!validPassword(newPassword))
            return fail(
                res,
                400,
                'Le nouveau mot de passe doit contenir au moins 12 caractères (72 octets maximum).'
            );
        const hash = await bcrypt.hash(newPassword, 12);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
        const token = req.cookies[SESSION_COOKIE];
        const currentTokenHash = crypto.createHash('sha256').update(token).digest('hex');
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(
            req.user.id,
            currentTokenHash
        );
        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

app.get('/api/events', requireAuth, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    const client = { userId: req.user.id, response: res };
    eventClients.add(client);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => {
        clearInterval(heartbeat);
        eventClients.delete(client);
    });
});

app.get('/api/bootstrap', requireAuth, (req, res) => {
    const user = req.user;
    const isDirector = user.role === 'dg';
    const isAdmin = user.role === 'admin';
    const documents = db
        .prepare(
            `
        SELECT d.*, u.name AS sender, u.role AS sender_role
        FROM documents d JOIN users u ON u.id = d.sender_id
        WHERE d.sender_id = ? OR d.receiver_role = ? OR ?
        ORDER BY d.created_at DESC
    `
        )
        .all(user.id, user.role, isDirector ? 1 : 0)
        .map((doc) => ({
            ...doc,
            history: db
                .prepare(
                    `
            SELECT h.step, h.status, h.created_at AS date, u.name AS user
            FROM document_history h JOIN users u ON u.id = h.user_id
            WHERE h.document_id = ? ORDER BY h.id
        `
                )
                .all(doc.id)
        }));
    const requests = db
        .prepare(
            `
        SELECT r.*, u.name AS sender
        FROM requests r JOIN users u ON u.id = r.sender_id
        WHERE (r.sender_id = ? OR r.receiver_role = ?)
            AND NOT EXISTS (
                SELECT 1 FROM hidden_requests h
                WHERE h.request_id = r.id AND h.user_id = ?
            )
        ORDER BY r.created_at DESC
    `
        )
        .all(user.id, user.role, user.id);
    const messages = db
        .prepare(
            `
        SELECT m.id, m.receiver_role, m.body, m.created_at, u.name AS sender, u.role AS sender_role
        FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE (m.receiver_role = ? OR m.sender_id = ?)
            AND NOT EXISTS (
                SELECT 1 FROM hidden_messages h
                WHERE h.message_id = m.id AND h.user_id = ?
            )
        ORDER BY m.id DESC LIMIT 100
    `
        )
        .all(user.role, user.id, user.id)
        .reverse();
    const announcements = db
        .prepare(
            `
        SELECT a.id, a.title, a.body, a.priority, a.created_at, u.name AS author
        FROM announcements a JOIN users u ON u.id = a.author_id
        WHERE NOT EXISTS (
            SELECT 1 FROM hidden_announcements h
            WHERE h.announcement_id = a.id AND h.user_id = ?
        )
        ORDER BY a.created_at DESC
    `
        )
        .all(user.id);
    const notifications = db
        .prepare(
            `
        SELECT id, title, body AS text, read AS unread, created_at AS time
        FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100
    `
        )
        .all(user.id)
        .map((item) => ({ ...item, unread: !item.unread }));
    const users = isAdmin
        ? db.prepare('SELECT id, name, email, role, is_active FROM users ORDER BY name').all()
        : [];
    res.json({ user: publicUser(user), documents, requests, messages, announcements, notifications, users });
});

// Administration des comptes et de leurs accès.
app.post('/api/users', requireRole('admin'), async (req, res, next) => {
    try {
        const name = cleanText(req.body.name, 100);
        const email = cleanText(req.body.email, 254).toLowerCase();
        const password = req.body.password;
        const role = req.body.role;
        if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !validPassword(password) || !roles[role]) {
            return fail(
                res,
                400,
                'Vérifiez le nom, l’e-mail, le rôle et le mot de passe (12 caractères minimum, 72 octets maximum).'
            );
        }
        if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
            return fail(res, 409, 'Un compte existe déjà avec cette adresse e-mail.');
        }
        const passwordHash = await bcrypt.hash(password, 12);
        if (db.prepare('SELECT 1 FROM users WHERE role = ? AND is_active = 1').get(role)) {
            return fail(res, 409, 'Ce rôle est déjà attribué à un compte actif.');
        }
        const result = db
            .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
            .run(name, email, passwordHash, role);
        const user = db
            .prepare('SELECT id, name, email, role FROM users WHERE id = ?')
            .get(result.lastInsertRowid);
        res.status(201).json({ user: publicUser(user) });
    } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed: users.email'))
            return fail(res, 409, 'Un compte existe déjà avec cette adresse e-mail.');
        next(error);
    }
});

app.delete('/api/users/:id', requireRole('admin'), (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isSafeInteger(userId) || userId < 1)
        return fail(res, 400, 'Identifiant de compte non valide.');
    if (userId === req.user.id) return fail(res, 400, 'Vous ne pouvez pas désactiver votre propre compte.');

    const user = db.prepare('SELECT id, role, is_active FROM users WHERE id = ?').get(userId);
    if (!user || !user.is_active) return fail(res, 404, 'Compte introuvable ou déjà désactivé.');
    if (
        user.role === 'admin' &&
        db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1").get()
            .count <= 1
    ) {
        return fail(res, 409, 'Impossible de désactiver le dernier compte administrateur actif.');
    }

    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    for (const client of eventClients) {
        if (client.userId === userId) {
            eventClients.delete(client);
            client.response.end();
        }
    }
    publish('refresh', { userId: req.user.id });
    res.json({ ok: true });
});

app.patch('/api/users/:id/activate', requireRole('admin'), (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isSafeInteger(userId) || userId < 1)
        return fail(res, 400, 'Identifiant de compte non valide.');
    const user = db.prepare('SELECT role, is_active FROM users WHERE id = ?').get(userId);
    if (!user || user.is_active) return fail(res, 404, 'Compte introuvable ou déjà actif.');
    if (db.prepare('SELECT 1 FROM users WHERE role = ? AND is_active = 1').get(user.role)) {
        return fail(res, 409, 'Ce rôle est déjà attribué à un compte actif.');
    }
    const result = db.prepare('UPDATE users SET is_active = 1 WHERE id = ? AND is_active = 0').run(userId);
    if (result.changes === 0) return fail(res, 404, 'Compte introuvable ou déjà actif.');
    publish('refresh', { userId: req.user.id });
    res.json({ ok: true });
});

// Gestion des documents, fichiers privés et historiques de traitement.
app.post('/api/documents', requireAuth, upload.single('attachment'), (req, res, next) => {
    let committed = false;
    try {
        const title = cleanText(req.body.title, 180);
        const category = cleanText(req.body.category, 60);
        const receiverRole = req.body.receiverRole;
        const notes = cleanText(req.body.notes, 2000);
        if (!title || !DOCUMENT_CATEGORIES.has(category) || !roles[receiverRole] || !req.file) {
            if (req.file) fs.rmSync(req.file.path, { force: true });
            return fail(res, 400, 'Le titre, la catégorie, le destinataire et le fichier sont obligatoires.');
        }
        const descriptor = fs.openSync(req.file.path, 'r');
        const signature = Buffer.alloc(8);
        const bytesRead = fs.readSync(descriptor, signature, 0, signature.length, 0);
        fs.closeSync(descriptor);
        const extension = path.extname(req.file.originalname).toLowerCase();
        const validSignature =
            extension === '.pdf'
                ? signature.subarray(0, 5).toString() === '%PDF-'
                : extension === '.doc'
                  ? signature.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
                  : extension === '.docx' && bytesRead >= 4 && signature[0] === 0x50 && signature[1] === 0x4b;
        if (!validSignature) {
            fs.rmSync(req.file.path, { force: true });
            return fail(res, 400, 'Le contenu du fichier ne correspond pas à son format déclaré.');
        }
        const id = `DOC-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const notifiedUserIds = [];
        db.exec('BEGIN IMMEDIATE');
        let transactionOpen = true;
        try {
            db.prepare(
                `
                INSERT INTO documents (id, title, category, sender_id, receiver_role, notes, file_name, stored_name, mime_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                id,
                title,
                category,
                req.user.id,
                receiverRole,
                notes,
                path.basename(req.file.originalname),
                req.file.filename,
                req.file.mimetype
            );
            db.prepare(
                'INSERT INTO document_history (document_id, user_id, step, status) VALUES (?, ?, ?, ?)'
            ).run(id, req.user.id, 'Document transmis', 'En cours');
            const notificationUsers = db
                .prepare('SELECT id FROM users WHERE role = ? AND is_active = 1')
                .all(receiverRole);
            const insertNotification = db.prepare(
                'INSERT INTO notifications (user_id, title, body) VALUES (?, ?, ?)'
            );
            for (const user of notificationUsers) {
                if (user.id === req.user.id) continue;
                insertNotification.run(user.id, 'Nouveau document reçu', `${title} vous a été transmis.`);
                notifiedUserIds.push(user.id);
            }
            db.exec('COMMIT');
            transactionOpen = false;
            committed = true;
        } catch (error) {
            if (transactionOpen) db.exec('ROLLBACK');
            throw error;
        }
        for (const userId of notifiedUserIds) publish('refresh', { userId });
        res.status(201).json({ id });
    } catch (error) {
        if (req.file && !committed) fs.rmSync(req.file.path, { force: true });
        next(error);
    }
});

app.get('/api/documents/:id/file', requireAuth, (req, res) => {
    const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!document) return fail(res, 404, 'Document introuvable.');
    if (
        req.user.role !== 'dg' &&
        document.sender_id !== req.user.id &&
        document.receiver_role !== req.user.role
    )
        return fail(res, 403, 'Accès interdit à ce document.');
    const filePath = path.join(UPLOAD_DIR, path.basename(document.stored_name));
    if (!fs.existsSync(filePath)) return fail(res, 404, 'Le fichier associé est introuvable sur le serveur.');
    const downloadName = document.file_name.replace(/[\u0000-\u001f\u007f"\\/]/g, '_');
    res.type(document.mime_type);
    res.attachment(downloadName);
    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
        console.error(error);
        if (!res.headersSent) fail(res, 500, 'Le téléchargement du document a échoué.');
        else res.destroy(error);
    });
    stream.pipe(res);
});

app.patch('/api/documents/:id/status', requireAuth, (req, res) => {
    const status = req.body.status;
    if (!['Validé', 'Rejeté'].includes(status)) return fail(res, 400, 'Statut non valide.');
    const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!document) return fail(res, 404, 'Document introuvable.');
    if (req.user.role !== 'dg' && document.receiver_role !== req.user.role)
        return fail(res, 403, 'Seul le destinataire peut traiter ce document.');
    db.prepare('UPDATE documents SET status = ? WHERE id = ?').run(status, document.id);
    db.prepare('INSERT INTO document_history (document_id, user_id, step, status) VALUES (?, ?, ?, ?)').run(
        document.id,
        req.user.id,
        status === 'Validé' ? 'Document validé' : 'Document rejeté',
        status
    );
    createNotification(
        document.sender_id,
        `Document ${status.toLowerCase()}`,
        `${document.title} a été marqué « ${status} ».`
    );
    res.json({ ok: true });
});

// Demandes administratives et messagerie par service.
app.post('/api/requests', requireAuth, (req, res) => {
    const student = req.user.name;
    const object = cleanText(req.body.object, 180);
    const priority = cleanText(req.body.priority, 20);
    const receiverRole = cleanText(req.body.receiverRole, 30);
    if (!object) return fail(res, 400, 'Saisissez l’objet de la demande.');
    if (!['Normal', 'Important', 'Urgent'].includes(priority))
        return fail(res, 400, 'Choisissez une priorité valide pour la demande.');
    if (!roles[receiverRole]) return fail(res, 400, 'Choisissez un service destinataire valide.');
    const duplicate = db
        .prepare(
            `SELECT id FROM requests
            WHERE sender_id = ? AND receiver_role = ? AND lower(object) = lower(?)
                AND status NOT IN ('Terminé', 'Rejeté')
            ORDER BY created_at DESC LIMIT 1`
        )
        .get(req.user.id, receiverRole, object);
    if (duplicate) return fail(res, 409, `Une demande identique est déjà ouverte (${duplicate.id}).`);
    const id = `REQ-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    db.prepare(
        'INSERT INTO requests (id, sender_id, receiver_role, student, object, priority) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, req.user.id, receiverRole, student, object, priority);
    createRoleNotifications(receiverRole, 'Nouvelle demande reçue', `${object} — ${req.user.name}`, req.user.id);
    res.status(201).json({ id });
});

app.patch('/api/requests/:id/status', requireAuth, (req, res) => {
    const status = req.body.status;
    if (!['En attente', 'En traitement', 'Terminé', 'Rejeté'].includes(status))
        return fail(res, 400, 'Statut non valide.');
    const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
    if (!request) return fail(res, 404, 'Demande introuvable.');
    if (request.receiver_role !== req.user.role)
        return fail(res, 403, 'Seul le destinataire peut traiter cette demande.');
    db.prepare(
        `UPDATE requests SET status = ?
        WHERE sender_id = ? AND receiver_role = ? AND student = ?
            AND lower(object) = lower(?) AND priority = ?
            AND status NOT IN ('Terminé', 'Rejeté')`
    ).run(
        status,
        request.sender_id,
        request.receiver_role,
        request.student,
        request.object,
        request.priority
    );
    createNotification(request.sender_id, 'Mise à jour de votre demande', `${request.object} : ${status}.`);
    res.json({ ok: true });
});

app.delete('/api/requests', requireAuth, (req, res) => {
    db.prepare(
        `INSERT OR IGNORE INTO hidden_requests (user_id, request_id)
        SELECT ?, id FROM requests WHERE sender_id = ? OR receiver_role = ?`
    ).run(req.user.id, req.user.id, req.user.role);
    publish('refresh', { userId: req.user.id });
    res.json({ ok: true });
});

app.delete('/api/requests/:id', requireAuth, (req, res) => {
    const request = db
        .prepare('SELECT id FROM requests WHERE id = ? AND (sender_id = ? OR receiver_role = ?)')
        .get(req.params.id, req.user.id, req.user.role);
    if (!request) return fail(res, 404, 'Demande introuvable.');
    db.prepare('INSERT OR IGNORE INTO hidden_requests (user_id, request_id) VALUES (?, ?)').run(
        req.user.id,
        request.id
    );
    publish('refresh', { userId: req.user.id });
    res.json({ ok: true });
});

app.post('/api/messages', requireAuth, (req, res) => {
    const body = cleanText(req.body.body, 3000);
    const receiverRole = req.body.receiverRole;
    if (!body || !roles[receiverRole])
        return fail(res, 400, 'Choisissez un destinataire et saisissez un message.');
    db.prepare('INSERT INTO messages (sender_id, receiver_role, body) VALUES (?, ?, ?)').run(
        req.user.id,
        receiverRole,
        body
    );
    createRoleNotifications(
        receiverRole,
        'Nouveau message',
        `${req.user.name} vous a envoyé un message.`,
        req.user.id
    );
    res.status(201).json({ ok: true });
});

app.delete('/api/messages/:id', requireAuth, (req, res) => {
    const messageId = Number(req.params.id);
    if (!Number.isSafeInteger(messageId) || messageId < 1)
        return fail(res, 400, 'Identifiant de message non valide.');
    const message = db
        .prepare(
            `
        SELECT id FROM messages
        WHERE id = ? AND (receiver_role = ? OR sender_id = ?)
    `
        )
        .get(messageId, req.user.role, req.user.id);
    if (!message) return fail(res, 404, 'Message introuvable.');
    db.prepare('INSERT OR IGNORE INTO hidden_messages (user_id, message_id) VALUES (?, ?)').run(
        req.user.id,
        messageId
    );
    publish('refresh', { userId: req.user.id });
    res.json({ ok: true });
});

app.delete('/api/messages', requireAuth, (req, res) => {
    db.prepare(
        `INSERT OR IGNORE INTO hidden_messages (user_id, message_id)
        SELECT ?, id FROM messages WHERE receiver_role = ? OR sender_id = ?`
    ).run(req.user.id, req.user.role, req.user.id);
    publish('refresh', { userId: req.user.id });
    res.json({ ok: true });
});

// Annonces et notifications persistées en base.
app.post('/api/announcements', requireRole(...announcementRoles), (req, res) => {
    const title = cleanText(req.body.title, 180);
    const body = cleanText(req.body.body, 3000);
    const priority = req.body.priority;
    if (!title || !body || !['GÉNÉRAL', 'URGENT'].includes(priority))
        return fail(res, 400, 'Vérifiez le titre, le contenu et la priorité.');
    db.prepare('INSERT INTO announcements (author_id, title, body, priority) VALUES (?, ?, ?, ?)').run(
        req.user.id,
        title,
        body,
        priority
    );
    const users = db.prepare('SELECT id FROM users WHERE id != ? AND is_active = 1').all(req.user.id);
    for (const user of users) createNotification(user.id, 'Nouvelle annonce', title);
    publish('refresh', {});
    res.status(201).json({ ok: true });
});

app.delete('/api/announcements/:id', requireAuth, (req, res) => {
    const announcementId = Number(req.params.id);
    if (!Number.isSafeInteger(announcementId) || announcementId < 1)
        return fail(res, 400, 'Identifiant d’annonce non valide.');
    const announcement = db.prepare('SELECT id FROM announcements WHERE id = ?').get(announcementId);
    if (!announcement) return fail(res, 404, 'Annonce introuvable.');
    db.prepare(
        'INSERT OR IGNORE INTO hidden_announcements (user_id, announcement_id) VALUES (?, ?)'
    ).run(req.user.id, announcementId);
    publish('refresh', { userId: req.user.id });
    res.json({ ok: true });
});

app.delete('/api/announcements', requireAuth, (req, res) => {
    db.prepare(
        `INSERT OR IGNORE INTO hidden_announcements (user_id, announcement_id)
        SELECT ?, id FROM announcements`
    ).run(req.user.id);
    publish('refresh', { userId: req.user.id });
    res.json({ ok: true });
});

app.delete('/api/notifications/:id', requireAuth, (req, res) => {
    const notificationId = Number(req.params.id);
    if (!Number.isSafeInteger(notificationId) || notificationId < 1)
        return fail(res, 400, 'Identifiant de notification non valide.');
    const result = db
        .prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?')
        .run(notificationId, req.user.id);
    if (result.changes === 0) return fail(res, 404, 'Notification introuvable.');
    res.json({ ok: true });
});

app.delete('/api/notifications', requireAuth, (req, res) => {
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
});

app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(
        req.params.id,
        req.user.id
    );
    res.json({ ok: true });
});

// Convertit les erreurs serveur en réponses API cohérentes.
app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed')
        return fail(res, 400, 'Le corps JSON de la requête est invalide.');
    if (error instanceof multer.MulterError) {
        const message =
            error.code === 'LIMIT_FILE_SIZE'
                ? 'Le fichier dépasse la limite de 15 Mo.'
                : 'Le fichier n’a pas pu être téléversé.';
        return fail(res, 400, message);
    }
    if (error.message?.startsWith('Format non accepté')) return fail(res, 400, error.message);
    console.error(error);
    return fail(res, 500, 'Une erreur interne est survenue.');
});

app.listen(PORT, HOST, () => {
    console.log(`AdminFlow disponible sur http://${HOST}:${PORT}`);
    console.log('Au premier démarrage, créez le compte administrateur dans l’écran de configuration.');
});
