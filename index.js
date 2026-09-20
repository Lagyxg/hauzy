/**
 * BEARS™ stats updater
 * Список участников берётся из stats.json (поле username — TikTok-юзернейм).
 * Скрипт тянет статистику через неофициальный API tikwm.com, обновляет
 * просмотры/лайки/подписчики/рост, а всё остальное (nickname, role, joined,
 * telegram и любые другие поля) оставляет как есть. Затем перезаписывает
 * stats.json и (опционально) пушит его в GitHub.
 *
 * Запуск: node index.js
 */
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ────────── НАСТРОЙКИ ──────────
const LAST_VIDEOS = 20;      // сколько последних видео суммировать в "просмотры"
const DELAY_MS = 1500;       // пауза между запросами (у бесплатного tikwm лимит ~1 запрос/сек)
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'stats.json');
const API_BASE = 'https://www.tikwm.com/api';

// Для автопуша в GitHub (переменные окружения на хостинге).
// Если заданы — скрипт сам клонирует репозиторий, читает список участников
// оттуда, обновляет stats.json и пушит обратно. Если нет — работает с локальным файлом.
//   GITHUB_TOKEN  — fine-grained PAT с правом Contents: Read and write на репозиторий
//   GITHUB_REPO   — "username/repo"
//   GITHUB_BRANCH — ветка, которую деплоит Netlify (по умолчанию main)
//   GITHUB_FILE   — путь к stats.json внутри репозитория (по умолчанию stats.json)
// ───────────────────────────────

const http = axios.create({
  baseURL: API_BASE,
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.tikwm.com/',
    'Origin': 'https://www.tikwm.com'
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function call(endpoint, params, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const { data } = await http.get(endpoint, { params });
      if (data && data.code === 0 && data.data) return data.data;
      throw new Error((data && data.msg) || 'пустой ответ API');
    } catch (e) {
      const status = e.response && e.response.status;
      if (i === tries || status === 401 || status === 403) throw e;
      await sleep(DELAY_MS * i * 2); // растущая пауза перед повтором
    }
  }
}

async function fetchProfile(username) {
  const info = await call('/user/info', { unique_id: username });
  await sleep(DELAY_MS);
  const posts = await call('/user/posts', { unique_id: username, count: LAST_VIDEOS, cursor: 0 });

  const stats = info.stats || {};
  const user = info.user || {};
  const videos = posts.videos || [];

  return {
    avatar: user.avatarLarger || user.avatarMedium || user.avatarThumb || '',
    followers: stats.followerCount || 0,
    likes: stats.heartCount || stats.heart || 0,
    views: videos.reduce((sum, v) => sum + (v.play_count || 0), 0)
  };
}

// ────────── GitHub ──────────
const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
const scrub = (msg, token) => String(msg).split(token).join('***'); // не светим токен в логах

function githubConfig() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) return null;
  return {
    token, repo,
    branch: process.env.GITHUB_BRANCH || 'main',
    file: process.env.GITHUB_FILE || 'stats.json'
  };
}

function cloneRepo(gh) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bears-'));
  try {
    git(['clone', '--depth', '1', '--branch', gh.branch,
      `https://x-access-token:${gh.token}@github.com/${gh.repo}.git`, dir]);
    return dir;
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(scrub(e.message, gh.token));
  }
}

function commitAndPush(gh, dir) {
  try {
    git(['add', gh.file], dir);
    if (!git(['status', '--porcelain'], dir).trim()) {
      log('Изменений нет — коммит не нужен');
      return;
    }
    git(['-c', 'user.name=bears-bot', '-c', 'user.email=bears-bot@users.noreply.github.com',
      'commit', '-m', `stats: update ${new Date().toISOString().slice(0, 10)}`], dir);
    git(['push', 'origin', gh.branch], dir);
    log('stats.json запушен в GitHub, Netlify задеплоит сам');
  } catch (e) {
    throw new Error(scrub(e.message, gh.token));
  }
}

// ────────── основной процесс ──────────
async function updateStats(statsPath) {
  const data = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  const roster = Array.isArray(data.members) ? data.members : [];
  if (!roster.length) throw new Error('В stats.json нет участников (members пуст)');

  const members = [];
  let fresh = 0;
  let failsInRow = 0;

  for (const old of roster) {
    const username = String(old.username || '').trim().replace(/^@/, '');
    const label = username || old.nickname || '(без имени)';

    if (!username) {
      log(`SKIP ${label}: нет TikTok-юзернейма, статистику не обновляем`);
      members.push(old);
      continue;
    }

    try {
      const p = await fetchProfile(username);
      const growth = old.views
        ? Math.round(((p.views - old.views) / old.views) * 1000) / 10
        : 0;
      members.push({
        ...old, // nickname, role, joined, telegram и любые другие поля сохраняются
        username,
        avatar: p.avatar || old.avatar || '',
        views: p.views,
        likes: p.likes,
        followers: p.followers,
        growth
      });
      fresh++;
      failsInRow = 0;
      log(`OK  ${label}: views=${p.views} likes=${p.likes} followers=${p.followers}`);
    } catch (e) {
      const d = e.response && e.response.data;
      const body = d ? ' | ' + String(typeof d === 'string' ? d : JSON.stringify(d)).replace(/\s+/g, ' ').slice(0, 200) : '';
      log(`ERR ${label}: ${e.message}${body}`);
      members.push(old); // оставляем прошлые данные, чтобы сайт не ломался
      failsInRow++;
      if (fresh === 0 && failsInRow >= 4) {
        throw new Error('API отклоняет запросы (4 ошибки подряд, ни одного успеха) — останавливаюсь, stats.json не меняю');
      }
    }
    await sleep(DELAY_MS);
  }

  if (fresh === 0) {
    throw new Error('Ни один профиль не обновился — stats.json не трогаем');
  }

  members.sort((a, b) => (b.views || 0) - (a.views || 0));
  members.forEach((m, i) => { m.position = i + 1; });

  const result = {
    updated_at: new Date().toISOString(),
    total_views: members.reduce((s, m) => s + (m.views || 0), 0),
    members
  };

  const tmp = statsPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n');
  fs.renameSync(tmp, statsPath);
  log(`stats.json обновлён (${members.length} участников, обновлено ${fresh})`);
}

async function main() {
  const gh = githubConfig();
  const workDir = gh ? cloneRepo(gh) : null;
  const statsPath = gh ? path.join(workDir, gh.file) : STATS_FILE;

  try {
    await updateStats(statsPath);
    if (gh) commitAndPush(gh, workDir);
    else log('GITHUB_TOKEN / GITHUB_REPO не заданы — пуш пропущен');
  } finally {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
