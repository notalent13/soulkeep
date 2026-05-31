import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import NodeID3 from "node-id3";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const ENV_CANDIDATES = [".env", "environment.env"];
const envPath = ENV_CANDIDATES.find((file) => fs.existsSync(path.resolve(file)));

if (!envPath) {
  console.error("No env file found. Create .env or environment.env in this folder.");
  process.exit(1);
}

dotenv.config({ path: envPath });

const API = process.env.SLSKD_API_URL;
const API_KEY = process.env.SLSKD_API_KEY;
const DRY_RUN = process.env.DRY_RUN !== "false";
const SEARCH_WAIT_SECONDS = Number(process.env.SEARCH_WAIT_SECONDS || 35);
const MAX_TRACKS = Number(process.env.MAX_TRACKS || 50);
const MIN_GOOD_MP3_SIZE = Number(process.env.MIN_GOOD_MP3_SIZE || 5_000_000);
const DEBUG_REJECTED = process.env.DEBUG_REJECTED === "true";
const API_TIMEOUT_SECONDS = Number(process.env.API_TIMEOUT_SECONDS || 30);
const DOWNLOAD_WAIT_SECONDS = Number(process.env.DOWNLOAD_WAIT_SECONDS || 60);
const TRACK_SEARCH_TIMEOUT_SECONDS = Number(process.env.TRACK_SEARCH_TIMEOUT_SECONDS || 90);
const API_RETRY_ATTEMPTS = Number(process.env.API_RETRY_ATTEMPTS || 3);
const API_RETRY_DELAY_SECONDS = Number(process.env.API_RETRY_DELAY_SECONDS || 3);
const DOWNLOAD_RETRY_CANDIDATES = Number(process.env.DOWNLOAD_RETRY_CANDIDATES || 3);
const DOWNLOAD_VERIFY_WAIT_SECONDS = Number(process.env.DOWNLOAD_VERIFY_WAIT_SECONDS || 45);
const DOWNLOAD_VERIFY_INTERVAL_SECONDS = Number(process.env.DOWNLOAD_VERIFY_INTERVAL_SECONDS || 5);

if (!API || !API_KEY) {
  console.error(`Missing SLSKD_API_URL or SLSKD_API_KEY in ${envPath}`);
  process.exit(1);
}

function findJspfFile() {
  const argPath = process.argv[2];

  if (argPath) return argPath;

  const jspfFiles = fs
    .readdirSync(process.cwd())
    .filter((file) => file.toLowerCase().endsWith(".jspf"))
    .map((file) => ({
      file,
      mtime: fs.statSync(path.resolve(file)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!jspfFiles.length) {
    console.error("No .jspf file found in this folder.");
    process.exit(1);
  }

  if (jspfFiles.length > 1) {
    console.log(`No JSPF file specified. Using newest JSPF file: ${jspfFiles[0].file}`);
  }

  return jspfFiles[0].file;
}

const jspfPath = findJspfFile();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableApiError(err) {
  const message = String(err?.message || err || "");
  return (
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("Bad Gateway") ||
    message.includes("Gateway Timeout") ||
    message.includes("AbortError") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
}

async function withTimeout(promise, timeoutMs, label = "operation") {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function sanitizeFolderName(value) {
  return String(value || "playlist")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getPlaylistFolderName(filePath) {
  return sanitizeFolderName(path.basename(filePath, path.extname(filePath)));
}

const playlistFolder = getPlaylistFolderName(jspfPath);

function normalizeText(value = "") {
  return String(value || "")
    .replace(/×/g, " ")
    .replace(/&/g, " and ")
    .replace(/\$/g, "s")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[()[\]{}]/g, " ")
    .replace(/[._\-/:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeFeat(value = "") {
  return value
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, "")
    .replace(/\s+x\s+.*$/i, "")
    .trim();
}

function getTrackArtist(track) {
  return track.creator || track.artist || track.artist_credit_name || "";
}

function getTrackTitle(track) {
  return track.title || track.track || track.name || "";
}

function getFilename(file) {
  return file.filename || file.fileName || file.path || file.name || "";
}

function isMp3File(name) {
  return /\.mp3$/i.test(String(name || "").trim());
}

function isBadFormat(name) {
  const n = String(name || "").toLowerCase();

  return (
    n.endsWith(".lrc") ||
    n.endsWith(".txt") ||
    n.endsWith(".cue") ||
    n.endsWith(".jpg") ||
    n.endsWith(".png") ||
    n.endsWith(".flac") ||
    n.endsWith(".wav") ||
    n.endsWith(".ape") ||
    n.endsWith(".m4a") ||
    n.endsWith(".aac") ||
    n.endsWith(".ogg") ||
    n.endsWith(".opus") ||
    n.endsWith(".m3u") ||
    n.endsWith(".nfo") ||
    n.endsWith(".sfv")
  );
}

function looksLike320(file) {
  if (Number(file.bitRate) === 320) return true;
  if (Number(file.bitrate) === 320) return true;
  if (Number(file.bit_rate) === 320) return true;

  const attrs = Array.isArray(file.attributes)
    ? file.attributes.join(" ").toLowerCase()
    : String(file.attributes || "").toLowerCase();

  return /\b320\s*(kbps|kbit|kb\/s)\b/i.test(attrs);
}

function isGoodMp3Candidate(file) {
  const name = getFilename(file);
  const size = Number(file.size || 0);

  if (!name) return { ok: false, reason: "no filename" };
  if (size <= 0) return { ok: false, reason: "no size" };
  if (!isMp3File(name)) return { ok: false, reason: "not mp3" };
  if (isBadFormat(name)) return { ok: false, reason: "bad format" };
  if (file.isLocked === true) return { ok: false, reason: "locked" };
  if (!looksLike320(file)) return { ok: false, reason: "not 320" };
  if (size < MIN_GOOD_MP3_SIZE) return { ok: false, reason: "too small" };

  return { ok: true, reason: "ok" };
}

function getResponseFiles(user) {
  if (Array.isArray(user.files)) return user.files;
  if (Array.isArray(user.files?.items)) return user.files.items;
  if (Array.isArray(user.fileList)) return user.fileList;
  if (Array.isArray(user.results)) return user.results;
  if (Array.isArray(user.children)) return user.children;
  return [];
}

function wordScore(filename, value, points) {
  const words = normalizeText(value)
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  let score = 0;

  for (const word of words) {
    if (filename.includes(word)) score += points;
  }

  return score;
}

function scoreResult(user, file, title, artist) {
  const filename = getFilename(file).toLowerCase();
  const normalizedFilename = normalizeText(filename).toLowerCase();
  const normalizedArtist = normalizeText(artist).toLowerCase();
  const normalizedTitle = normalizeText(title).toLowerCase();

  let score = 0;

  if (isMp3File(filename)) score += 50;
  if (looksLike320(file)) score += 90;
  if (file.isLocked === false) score += 20;
  if (user.hasFreeUploadSlot) score += 25;

  score += Math.min(user.uploadSpeed || 0, 10_000_000) / 1_000_000;
  score -= Math.min(user.queueLength || 0, 100) * 0.7;

  score += wordScore(normalizedFilename, title, 6);
  score += wordScore(normalizedFilename, artist, 5);

  if (normalizedFilename.includes(`${normalizedArtist} ${normalizedTitle}`)) score += 60;
  if (normalizedFilename.includes(`${normalizedArtist} - ${normalizedTitle}`)) score += 80;
  if (normalizedFilename.includes(normalizedTitle)) score += 20;

  if (normalizedFilename.includes("cover")) score -= 100;
  if (normalizedFilename.includes("tribute")) score -= 100;
  if (normalizedFilename.includes("karaoke")) score -= 100;
  if (normalizedFilename.includes("instrumental")) score -= 90;
  if (normalizedFilename.includes("remix")) score -= 70;
  if (normalizedFilename.includes("mix")) score -= 35;
  if (normalizedFilename.includes("live")) score -= 60;
  if (normalizedFilename.includes("acoustic")) score -= 80;
  if (normalizedFilename.includes("clean edit")) score -= 25;
  if (normalizedFilename.includes("radio edit")) score -= 20;
  if (normalizedFilename.includes("reimagined")) score -= 80;
  if (normalizedFilename.includes("re-recorded")) score -= 80;
  if (normalizedFilename.includes("rerecorded")) score -= 80;
  if (normalizedFilename.includes("remastered")) score -= 10;
  if (normalizedFilename.includes("hopeful sign")) score -= 100;

  // Album/source preference. Small bonuses only.
  if (normalizedFilename.includes("album")) score += 5;
  if (normalizedFilename.includes("greatest hits")) score += 2;
  if (normalizedFilename.includes("essentials")) score += 1;

  return score;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_SECONDS * 1000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function apiFetch(url, options = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= API_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {
        ...options,
        headers: {
          "X-API-Key": API_KEY,
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });

      const text = await res.text();

      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${text}`);
      }

      return text ? JSON.parse(text) : null;
    } catch (err) {
      lastError = err;

      if (!isRetryableApiError(err) || attempt >= API_RETRY_ATTEMPTS) {
        throw err;
      }

      console.log(`  API temporary error, retrying ${attempt}/${API_RETRY_ATTEMPTS}: ${err.message}`);
      await sleep(API_RETRY_DELAY_SECONDS * 1000 * attempt);
    }
  }

  throw lastError;
}

async function fetchArtworkFromITunes(artist, title) {
  const query = encodeURIComponent(`${artist} ${title}`);
  const url = `https://itunes.apple.com/search?term=${query}&entity=song&limit=5`;

  const badAlbumWords = [
    "greatest hits",
    "best of",
    "now that's what i call",
    "top hits",
    "essential",
    "playlist",
    "karaoke",
    "tribute",
    "compilation",
    "mix",
  ];

  try {
    const res = await fetchWithTimeout(url, {}, 15000);

    if (!res.ok) return null;

    const data = await res.json();
    const results = data.results || [];

    const filtered = results.filter((item) => {
      const album = (item.collectionName || "").toLowerCase();
      return !badAlbumWords.some((word) => album.includes(word));
    });

    const result = filtered[0] || results[0];

    if (!result?.artworkUrl100) return null;

    const artworkUrl = result.artworkUrl100.replace("100x100bb", "600x600bb");
    const imageRes = await fetchWithTimeout(artworkUrl, {}, 15000);

    if (!imageRes.ok) return null;

    const arrayBuffer = await imageRes.arrayBuffer();

    return {
      mime: "image/jpeg",
      type: {
        id: 3,
        name: "front cover",
      },
      description: "Cover",
      imageBuffer: Buffer.from(arrayBuffer),
    };
  } catch {
    return null;
  }
}

async function checkApi() {
  const app = await apiFetch(`${API}/application`);
  const state = app?.server?.state || "unknown";
  const username = app?.user?.username || "unknown";

  console.log(`Env file: ${envPath}`);
  console.log(`API: ${API}`);
  console.log(`DRY_RUN=${DRY_RUN}`);
  console.log(`SEARCH_WAIT_SECONDS=${SEARCH_WAIT_SECONDS}`);
  console.log(`MAX_TRACKS=${MAX_TRACKS}`);
  console.log(`MIN_GOOD_MP3_SIZE=${MIN_GOOD_MP3_SIZE}`);
  console.log(`API_TIMEOUT_SECONDS=${API_TIMEOUT_SECONDS}`);
  console.log(`DOWNLOAD_WAIT_SECONDS=${DOWNLOAD_WAIT_SECONDS}`);
  console.log(`TRACK_SEARCH_TIMEOUT_SECONDS=${TRACK_SEARCH_TIMEOUT_SECONDS}`);
  console.log(`API_RETRY_ATTEMPTS=${API_RETRY_ATTEMPTS}`);
  console.log(`DOWNLOAD_RETRY_CANDIDATES=${DOWNLOAD_RETRY_CANDIDATES}`);
  console.log(`DOWNLOAD_VERIFY_WAIT_SECONDS=${DOWNLOAD_VERIFY_WAIT_SECONDS}`);
  console.log(`Playlist folder: ${playlistFolder}`);
  console.log(`slskd: ${state}, user=${username}`);
  console.log("");
}

async function waitForSearch(searchId) {
  let status = null;

  for (let i = 0; i < SEARCH_WAIT_SECONDS; i++) {
    status = await apiFetch(`${API}/searches/${searchId}`);
    if (status.isComplete) break;
    await sleep(1000);
  }

  await sleep(1000);
  return status;
}

async function getSearchResponses(searchId, status) {
  let responses = await apiFetch(`${API}/searches/${searchId}/responses`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (responses?.length > 0 || !status?.fileCount) break;

    console.log(`  Responses empty, waiting 5s more... attempt ${attempt}/3`);
    await sleep(5000);
    responses = await apiFetch(`${API}/searches/${searchId}/responses`);
  }

  return responses || [];
}

async function searchTrack(artist, title) {
  const cleanArtist = removeFeat(normalizeText(artist));
  const cleanTitle = normalizeText(title);

  const searchText = `${cleanArtist} ${cleanTitle} mp3 320`;

  const search = await apiFetch(`${API}/searches`, {
    method: "POST",
    body: JSON.stringify({ searchText }),
  });

  const status = await waitForSearch(search.id);
  const responses = await getSearchResponses(search.id, status);

  console.log(`  Search: ${searchText}`);
  console.log(`  Search results: ${status?.fileCount || 0} files, ${status?.responseCount || 0} users`);

  const candidates = [];
  const rejected = [];

  for (const user of responses) {
    const files = getResponseFiles(user);

    for (const file of files) {
      const check = isGoodMp3Candidate(file);

      if (!check.ok) {
        if (DEBUG_REJECTED) {
          rejected.push({
            reason: check.reason,
            user: user.username,
            filename: getFilename(file),
            size: file.size,
            bitRate: file.bitRate,
            bitrate: file.bitrate,
            attributes: file.attributes,
            isLocked: file.isLocked,
          });
        }
        continue;
      }

      candidates.push({
        user,
        file,
        score: scoreResult(user, file, title, artist),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (!candidates.length && DEBUG_REJECTED) {
    console.log("  Rejected preview:");
    console.log(rejected.slice(0, 20));
  }

  return {
    searchText,
    best: candidates[0] || null,
    candidates,
  };
}

async function download(username, file) {
  return apiFetch(`${API}/transfers/downloads/${encodeURIComponent(username)}`, {
    method: "POST",
    body: JSON.stringify([
      {
        filename: getFilename(file),
        size: file.size,
        destination: playlistFolder,
      },
    ]),
  });
}

function buildFinalFileName(index, artist, title) {
  const number = String(index + 1).padStart(3, "0");
  return `${number} - ${sanitizeFileName(artist)} - ${sanitizeFileName(title)}.mp3`;
}

function buildOrderedTrackNames(tracks) {
  return tracks.map((track, index) => {
    const artist = sanitizeFileName(getTrackArtist(track));
    const title = sanitizeFileName(getTrackTitle(track));

    return {
      artist,
      title,
      fileName: buildFinalFileName(index, artist, title),
    };
  });
}

function normalizePathForCompare(value = "") {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function basenameFromAnyPath(value = "") {
  const normalized = normalizePathForCompare(value);
  return normalized.split("/").filter(Boolean).pop() || "";
}

async function writeCleanTags(destination, match) {
  if (!match) return;

  const oldTags = NodeID3.read(destination);
  let image = oldTags?.image || null;

  if (!image) {
    console.log(`  Artwork missing, searching: ${match.track.artist} - ${match.track.title}`);
    image = await fetchArtworkFromITunes(match.track.artist, match.track.title);
  }

  const tempFile = `${destination}.clean.mp3`;

  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      destination,
      "-map",
      "0:a",
      "-codec",
      "copy",
      "-map_metadata",
      "-1",
      tempFile,
    ]);

    fs.renameSync(tempFile, destination);
  } catch (err) {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }

    console.log(`  Warning: ffmpeg metadata cleanup failed for ${path.basename(destination)}: ${err.message}`);
    NodeID3.removeTags(destination);
  }

  const newTags = {
    title: match.track.title,
    artist: match.track.artist,
    performerInfo: "Various Artists",
    album: playlistFolder,
    trackNumber: String(match.index + 1),
  };

  if (image) {
    newTags.image = image;
  }

  const tagsWritten = NodeID3.write(newTags, destination);

  if (!tagsWritten) {
    console.log(`  Warning: could not write ID3 tags for ${path.basename(destination)}`);
  }
}

function getDownloadsRoot() {
  return process.env.SLSKD_DOWNLOADS_PATH || "./downloads";
}

function findDownloadedFileForCandidate(file) {
  const downloadsRoot = getDownloadsRoot();
  const targetBasename = basenameFromAnyPath(getFilename(file));
  const targetSize = Number(file.size || 0);

  if (!fs.existsSync(downloadsRoot) || !targetBasename || !targetSize) {
    return null;
  }

  const stack = [downloadsRoot];

  while (stack.length) {
    const dir = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.name.toLowerCase().endsWith(".mp3")) continue;
      if (basenameFromAnyPath(entry.name) !== targetBasename) continue;

      try {
        const actualSize = Number(fs.statSync(fullPath).size || 0);

        if (actualSize === targetSize) {
          return fullPath;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function waitForDownloadedFile(file) {
  const attempts = Math.max(1, Math.ceil(DOWNLOAD_VERIFY_WAIT_SECONDS / DOWNLOAD_VERIFY_INTERVAL_SECONDS));

  for (let i = 0; i < attempts; i++) {
    const found = findDownloadedFileForCandidate(file);

    if (found) {
      return found;
    }

    await sleep(DOWNLOAD_VERIFY_INTERVAL_SECONDS * 1000);
  }

  return null;
}

async function tryDownloadCandidates(result, trackIndex, artist, title) {
  const candidates = result.candidates.slice(0, Math.max(1, DOWNLOAD_RETRY_CANDIDATES));

  for (let i = 0; i < candidates.length; i++) {
    const { user, file, score } = candidates[i];
    const sourceFilename = getFilename(file);
    const finalFileName = buildFinalFileName(trackIndex, artist, title);

    console.log(`  Candidate ${i + 1}/${candidates.length}: ${user.username}`);
    console.log(`  File: ${sourceFilename}`);
    console.log(`  Size: ${file.size}`);
    console.log(`  Bitrate: ${file.bitRate ?? file.bitrate ?? "unknown"}`);
    console.log(`  Queue: ${user.queueLength}`);
    console.log(`  Speed: ${user.uploadSpeed}`);
    console.log(`  Score: ${score.toFixed(2)}`);

    const existingFile = findDownloadedFileForCandidate(file);

    if (existingFile) {
      console.log(`  Already downloaded: ${existingFile}`);

      return {
        queued: false,
        user,
        file,
        score,
        sourceFilename,
        finalFileName,
        downloadedPath: existingFile,
      };
    }

    try {
      const dl = await download(user.username, file);
      console.log(`  Download queued: ${dl.enqueued?.length || 0}`);
    } catch (err) {
      console.log(`  Candidate failed to enqueue: ${err.message}`);
      continue;
    }

    const downloadedFile = await waitForDownloadedFile(file);

    if (downloadedFile) {
      console.log(`  Download verified: ${downloadedFile}`);

      return {
        queued: true,
        user,
        file,
        score,
        sourceFilename,
        finalFileName,
        downloadedPath: downloadedFile,
      };
    }

    console.log("  Candidate did not finish in time, trying next candidate...");
  }

  return null;
}

const raw = fs.readFileSync(path.resolve(jspfPath), "utf-8");
const jspf = JSON.parse(raw);
const tracks = jspf.playlist?.track || [];

await checkApi();

console.log(`JSPF file: ${jspfPath}`);
console.log(`Found ${tracks.length} tracks in JSPF`);
console.log("");

let processed = 0;
let queued = 0;
let skipped = 0;
const downloadManifest = [];
const tracksToProcess = tracks.slice(0, MAX_TRACKS);

for (let trackIndex = 0; trackIndex < tracksToProcess.length; trackIndex++) {
  const track = tracksToProcess[trackIndex];
  const artist = getTrackArtist(track);
  const title = getTrackTitle(track);

  if (!artist || !title) {
    skipped++;
    continue;
  }

  processed++;

  console.log(`\n[${processed}/${tracksToProcess.length}] ${artist} - ${title}`);

  try {
    const result = await withTimeout(
      searchTrack(artist, title),
      TRACK_SEARCH_TIMEOUT_SECONDS * 1000,
      `Search for ${artist} - ${title}`
    );

    if (!result.best) {
      console.log("  No good unlocked mp3 320 result found");
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      const { user, file, score } = result.best;
      console.log(`  Best: ${user.username}`);
      console.log(`  File: ${getFilename(file)}`);
      console.log(`  Size: ${file.size}`);
      console.log(`  Bitrate: ${file.bitRate ?? file.bitrate ?? "unknown"}`);
      console.log(`  Queue: ${user.queueLength}`);
      console.log(`  Speed: ${user.uploadSpeed}`);
      console.log(`  Score: ${score.toFixed(2)}`);
      console.log("  DRY RUN: not downloading");
      continue;
    }

    const downloaded = await tryDownloadCandidates(result, trackIndex, artist, title);

    if (!downloaded) {
      console.log("  No candidate downloaded successfully, skipping track");
      skipped++;
      continue;
    }

    queued++;

    downloadManifest.push({
      index: trackIndex,
      artist: sanitizeFileName(artist),
      title: sanitizeFileName(title),
      fileName: downloaded.finalFileName,
      sourceFilename: downloaded.sourceFilename,
      sourceBasename: basenameFromAnyPath(downloaded.sourceFilename),
      downloadedPath: downloaded.downloadedPath,
      size: Number(downloaded.file.size || 0),
    });

    await sleep(1000);
  } catch (err) {
    console.log(`  Error: ${err.message}`);
    skipped++;
  }
}

if (!DRY_RUN) {
  console.log("\nWaiting for downloads to finish...");
  await sleep(DOWNLOAD_WAIT_SECONDS * 1000);

  console.log("\nFlattening downloads...");
  await flattenDownloads();
}

console.log("\nDone");
console.log(`Processed: ${processed}`);
console.log(`Queued: ${queued}`);
console.log(`Skipped: ${skipped}`);

async function flattenDownloads() {
  const downloadsRoot = getDownloadsRoot();
  const finalMusicRoot = process.env.FINAL_MUSIC_PATH || downloadsRoot;
  const targetDir = path.join(finalMusicRoot, playlistFolder);

  fs.mkdirSync(targetDir, { recursive: true });

  const movedManifestIndexes = new Set();

  function getUniqueDestination(fileName) {
    const parsed = path.parse(fileName);

    let destination = path.join(targetDir, fileName);
    let counter = 2;

    while (fs.existsSync(destination)) {
      destination = path.join(targetDir, `${parsed.name}_${counter}${parsed.ext}`);
      counter++;
    }

    return destination;
  }

  function findManifestFile(item) {
    if (item.downloadedPath && fs.existsSync(item.downloadedPath)) {
      return item.downloadedPath;
    }

    const targetBasename = item.sourceBasename;
    const targetSize = Number(item.size || 0);

    if (!fs.existsSync(downloadsRoot) || !targetBasename || !targetSize) {
      return null;
    }

    const stack = [downloadsRoot];

    while (stack.length) {
      const dir = stack.pop();
      let entries = [];

      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (fullPath === targetDir) continue;

        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }

        if (!entry.name.toLowerCase().endsWith(".mp3")) continue;
        if (basenameFromAnyPath(entry.name) !== targetBasename) continue;

        try {
          const actualSize = Number(fs.statSync(fullPath).size || 0);

          if (actualSize === targetSize) {
            return fullPath;
          }
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  function cleanupEmptyDirs(dir) {
    if (!fs.existsSync(dir)) return;

    let entries = [];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        cleanupEmptyDirs(path.join(dir, entry.name));
      }
    }

    if (dir !== downloadsRoot && dir !== targetDir) {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
        }
      } catch {
        // Ignore cleanup errors. Downloads can still be in use by slskd.
      }
    }
  }

  for (const item of downloadManifest) {
    if (movedManifestIndexes.has(item.index)) continue;

    const sourcePath = findManifestFile(item);

    if (!sourcePath) {
      console.log(`  Warning: verified file not found for ${item.fileName}; skipping move`);
      continue;
    }

    const match = {
      source: "manifest",
      index: item.index,
      track: {
        artist: item.artist,
        title: item.title,
        fileName: item.fileName,
      },
    };

    const destination = getUniqueDestination(item.fileName);

    fs.copyFileSync(sourcePath, destination);
    fs.unlinkSync(sourcePath);

    await writeCleanTags(destination, match);

    movedManifestIndexes.add(item.index);

    console.log(`  Moved: ${path.basename(sourcePath)} -> ${path.basename(destination)} [manifest]`);
  }

  cleanupEmptyDirs(downloadsRoot);

  console.log(`\nAll verified MP3 files moved to: ${targetDir}`);
  console.log(`Manifest files moved: ${movedManifestIndexes.size}/${downloadManifest.length}`);
  console.log("Extra late/failed candidates were left in slskd downloads and were not moved to Jellyfin.");
}
