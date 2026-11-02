const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.ADMINFLOW_DATA_DIR || path.join(ROOT_DIR, 'data'));
const UPLOAD_DIR = path.resolve(process.env.ADMINFLOW_UPLOAD_DIR || path.join(ROOT_DIR, 'uploads'));
const DATABASE_PATH = path.join(DATA_DIR, 'adminflow.sqlite');
const MANIFEST_NAME = 'manifest.json';

function isWithin(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function copyUploads(sourceDir, destinationDir, manifestEntries, relativeDir = '') {
    for (const entry of fs.readdirSync(path.join(sourceDir, relativeDir), { withFileTypes: true })) {
        const relativePath = path.join(relativeDir, entry.name);
        const sourcePath = path.join(sourceDir, relativePath);
        const destinationPath = path.join(destinationDir, relativePath);
        if (entry.isSymbolicLink()) throw new Error(`Le lien symbolique n’est pas pris en charge : ${relativePath}`);
        if (entry.isDirectory()) {
            fs.mkdirSync(destinationPath, { recursive: true, mode: 0o700 });
            copyUploads(sourceDir, destinationDir, manifestEntries, relativePath);
            continue;
        }
        if (!entry.isFile()) throw new Error(`Type de fichier non pris en charge : ${relativePath}`);
        fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
        manifestEntries.push({
            path: `uploads/${relativePath.split(path.sep).join('/')}`,
            sha256: null
        });
    }
}

function checkDatabase(databasePath) {
    const database = new DatabaseSync(databasePath);
    try {
        const integrity = database.prepare('PRAGMA integrity_check').all();
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
            throw new Error(`Échec de PRAGMA integrity_check : ${JSON.stringify(integrity)}`);
        }
        const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
        if (foreignKeyErrors.length > 0) {
            throw new Error(`La base contient des références invalides : ${JSON.stringify(foreignKeyErrors)}`);
        }
        return database.prepare('SELECT stored_name FROM documents').all().map((row) => row.stored_name);
    } finally {
        database.close();
    }
}

function resolveManifestPath(snapshotDir, relativePath) {
    if (
        typeof relativePath !== 'string' ||
        (relativePath !== 'adminflow.sqlite' && !relativePath.startsWith('uploads/')) ||
        relativePath.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
        throw new Error(`Chemin de manifeste non valide : ${relativePath}`);
    }
    const filePath = path.resolve(snapshotDir, ...relativePath.split('/'));
    if (!isWithin(snapshotDir, filePath) || !fs.lstatSync(filePath).isFile()) {
        throw new Error(`Fichier de sauvegarde manquant ou non valide : ${relativePath}`);
    }
    return filePath;
}

async function verifyBackup(snapshotPath) {
    const snapshotDir = path.resolve(snapshotPath);
    const manifestPath = path.join(snapshotDir, MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.formatVersion !== 1 || !Array.isArray(manifest.files)) {
        throw new Error('Format de manifeste de sauvegarde non pris en charge.');
    }
    const paths = new Set();
    for (const file of manifest.files) {
        if (!file || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) {
            throw new Error('Entrée de manifeste de sauvegarde non valide.');
        }
        paths.add(file.path);
        const filePath = resolveManifestPath(snapshotDir, file.path);
        if ((await hashFile(filePath)) !== file.sha256) {
            throw new Error(`Échec de vérification SHA-256 : ${file.path}`);
        }
    }
    if (!paths.has('adminflow.sqlite')) throw new Error('La base SQLite est absente du manifeste.');
    const storedNames = checkDatabase(path.join(snapshotDir, 'adminflow.sqlite'));
    for (const storedName of storedNames) {
        if (
            typeof storedName !== 'string' ||
            !storedName ||
            storedName.includes('/') ||
            storedName.includes('\\') ||
            !paths.has(`uploads/${storedName}`)
        ) {
            throw new Error(`Le fichier d’un document référencé manque dans la sauvegarde : ${storedName}`);
        }
    }
    console.log(`Sauvegarde vérifiée : ${snapshotDir}`);
}

async function createBackup() {
    const backupRoot = process.env.ADMINFLOW_BACKUP_DIR;
    if (!backupRoot) {
        throw new Error('Définissez ADMINFLOW_BACKUP_DIR vers un emplacement de sauvegarde sécurisé.');
    }
    if (!fs.existsSync(DATABASE_PATH) || !fs.statSync(DATABASE_PATH).isFile()) {
        throw new Error(`Base SQLite introuvable : ${DATABASE_PATH}`);
    }
    if (!fs.existsSync(UPLOAD_DIR) || !fs.statSync(UPLOAD_DIR).isDirectory()) {
        throw new Error(`Répertoire des documents introuvable : ${UPLOAD_DIR}`);
    }

    const resolvedBackupRoot = path.resolve(backupRoot);
    if (isWithin(DATA_DIR, resolvedBackupRoot) || isWithin(UPLOAD_DIR, resolvedBackupRoot)) {
        throw new Error('Le répertoire de sauvegarde ne peut pas se trouver dans data ou uploads.');
    }
    fs.mkdirSync(resolvedBackupRoot, { recursive: true, mode: 0o700 });

    const datePart = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const backupName = `adminflow-${datePart}-${crypto.randomBytes(4).toString('hex')}`;
    const snapshotDir = path.join(resolvedBackupRoot, backupName);
    const stagingDir = path.join(resolvedBackupRoot, `.${backupName}.tmp`);
    fs.mkdirSync(stagingDir, { mode: 0o700 });

    let database;
    try {
        database = new DatabaseSync(DATABASE_PATH);
        database.prepare('VACUUM INTO ?').run(path.join(stagingDir, 'adminflow.sqlite'));
        database.close();
        database = null;

        const entries = [{ path: 'adminflow.sqlite', sha256: await hashFile(path.join(stagingDir, 'adminflow.sqlite')) }];
        const backupUploads = path.join(stagingDir, 'uploads');
        fs.mkdirSync(backupUploads, { mode: 0o700 });
        copyUploads(UPLOAD_DIR, backupUploads, entries);
        for (const entry of entries.slice(1)) {
            entry.sha256 = await hashFile(resolveManifestPath(stagingDir, entry.path));
        }
        checkDatabase(path.join(stagingDir, 'adminflow.sqlite'));

        const manifest = {
            formatVersion: 1,
            createdAt: new Date().toISOString(),
            files: entries
        };
        fs.writeFileSync(
            path.join(stagingDir, MANIFEST_NAME),
            `${JSON.stringify(manifest, null, 2)}\n`,
            { flag: 'wx', mode: 0o600 }
        );
        fs.renameSync(stagingDir, snapshotDir);
        console.log(`Sauvegarde créée : ${snapshotDir}`);
    } catch (error) {
        if (database) database.close();
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw error;
    }
}

async function main() {
    if (process.argv[2] === '--verify' && process.argv.length === 4) {
        await verifyBackup(process.argv[3]);
        return;
    }
    if (process.argv.length !== 2) {
        throw new Error('Usage : npm run backup, ou npm run backup:verify -- <dossier-de-sauvegarde>');
    }
    await createBackup();
}

main().catch((error) => {
    console.error(`Erreur de sauvegarde : ${error.message}`);
    process.exitCode = 1;
});
