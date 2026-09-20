/**
 * BEARS™ stats updater (через Apify)
 *
 * Список участников берётся из stats.json (поле username — TikTok-юзернейм).
 * Скрипт запускает два готовых "актора" на Apify:
 *   1) mu0i/tiktok-user-posts          — последние видео каждого профиля → просмотры и лайки
 *   2) coregent/tiktok-profile-scraper — подписчики и аватарка (необязательно)
 * и обновляет в stats.json views / likes / growth / followers / avatar.
 * Всё остальное (nickname, role, joined, telegram ...) остаётся как есть.
 * Затем перезаписывает stats.json и (опционально) пушит его в GitHub.
 *
 * Запуск: APIFY_TOKEN=... node index.js
 */
const { ApifyClient } = require('apify-client');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ────────── НАСТРОЙКИ ──────────
const POSTS_ACTOR = process.env.APIFY_POSTS_ACTOR || 'mu0i/tiktok-user-posts';
// чтобы отключить второй актор (подписчики/аватарки): APIFY_PROFILE_ACTOR=off
const PROFILE_ACTOR = process.env.APIFY_PROFILE_ACTOR === 'off'
  ? ''
  : (process.env.APIFY_PROFILE_ACTOR || 'coregent/tiktok-profile-scraper');
// сколько последних видео каждого участника суммировать в "просмотры"
// (Apify берёт деньги за каждое видео: ~$0.0025 за штуку на бесплатном тарифе)
const MAX_POSTS = Number(process.env.MAX_POSTS) || 10;
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'stats.json');

// Для автопуша в GitHub (переменные окружения на хостинге).
// Если заданы — скрипт сам клонирует репозиторий, читает список участников
// оттуда, обновляет stats.json и пушит обратно. Если нет — работает с локальным файлом.
//   GITHUB_TOKEN  — fine-grained PAT с правом Contents: Read and write на репозиторий
//   GITHUB_REPO   — "username/repo"
//   GITHUB_BRANCH — ветка (по умолчанию main)
//   GITHUB_FILE   — путь к stats.json внутри репозитория (по умолчанию stats.json)
// ───────────────────────────────

const log = (...a) => console.log(new Date().toISOString(), ...a);
const clean = (u) => String(u || '').trim().replace(/^@/, '');

async function runActor(client, actorId, input) {
  const run = await client.actor(actorId).call(input, { waitSecs: 900 });
  if (run.status !== 'SUCCEEDED') {
    throw new Error(`${actorId}: запуск завершился со статусом ${run.status}`);
  }
  const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 5000 });
  return items;
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
    log('stats.json запушен в GitHub');
  } catch (e) {
    throw new Error(scrub(e.message, gh.token));
  }
}

// ────────── основной процесс ──────────
async function updateStats(statsPath) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('Не задан APIFY_TOKEN (API-токен из Apify Console → Settings → API & Integrations)');
  const client = new ApifyClient({ token });

  const data = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  const roster = Array.isArray(data.members) ? data.members : [];
  if (!roster.length) throw new Error('В stats.json нет участников (members пуст)');

  const usernames = [...new Set(roster.map((m) => clean(m.username)).filter(Boolean))];
  if (!usernames.length) throw new Error('Ни у одного участника не указан username');

  // 1) видео → просмотры и лайки
  log(`Apify: ${POSTS_ACTOR}, профилей: ${usernames.length}, видео на профиль: до ${MAX_POSTS}`);
  const rows = await runActor(client, POSTS_ACTOR, {
    profiles: usernames,
    maxPostsPerProfile: MAX_POSTS,
    includePinned: false,        // закреплённые могут быть старыми и портят "свежесть"
    includeDownloadUrls: false
  });

  const byUser = new Map();
  let skipped = 0;
  for (const r of rows) {
    if (!r || !r.authorUsername) {
      if (skipped++ < 2) log('Строка без видео (пропускаю):', JSON.stringify(r).slice(0, 200));
      continue;
    }
    const key = String(r.authorUsername).toLowerCase();
    const a = byUser.get(key) || { views: 0, likes: 0, videos: 0 };
    a.views += Number(r.playCount) || 0;
    a.likes += Number(r.likeCount) || 0;
    a.videos += 1;
    byUser.set(key, a);
  }
  log(`Получено видео: ${rows.length - skipped}, профилей с видео: ${byUser.size}`);
  if (!byUser.size) throw new Error('Актор не вернул ни одного видео — stats.json не трогаем');

  // 2) профили → подписчики и аватарка (не критично)
  const profiles = new Map();
  if (PROFILE_ACTOR) {
    try {
      log(`Apify: ${PROFILE_ACTOR}`);
      const prows = await runActor(client, PROFILE_ACTOR, { profiles: usernames });
      for (const p of prows) {
        if (p && p.username && p.success !== false) profiles.set(String(p.username).toLowerCase(), p);
      }
      log(`Профилей получено: ${profiles.size}`);
    } catch (e) {
      log(`WARN подписчики/аватарки не обновлены: ${e.message}`);
    }
  }

  // 3) склеиваем с текущим списком
  const members = [];
  let fresh = 0;
  for (const old of roster) {
    const username = clean(old.username);
    const label = username || old.nickname || '(без имени)';

    if (!username) {
      log(`SKIP ${label}: нет TikTok-юзернейма`);
      members.push(old);
      continue;
    }

    const key = username.toLowerCase();
    const posts = byUser.get(key);
    const prof = profiles.get(key);
    const next = { ...old, username }; // nickname, role, joined, telegram и др. сохраняются

    if (posts) {
      next.views = posts.views;
      next.likes = posts.likes;
      next.growth = old.views
        ? Math.round(((posts.views - old.views) / old.views) * 1000) / 10
        : 0;
      fresh++;
    } else {
      log(`WARN ${label}: видео не найдены (закрытый профиль, нет постов или неверный юзернейм) — просмотры оставляю прошлые`);
    }
    if (prof) {
      if (prof.followerCount != null) next.followers = prof.followerCount;
      if (prof.avatarUrl) next.avatar = prof.avatarUrl;
    }
    members.push(next);
    if (posts || prof) {
      log(`OK  ${label}: views=${next.views} likes=${next.likes} followers=${next.followers ?? '—'}`);
    }
  }

  if (fresh === 0) throw new Error('Ни одному участнику не удалось обновить просмотры — stats.json не трогаем');

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
  log(`stats.json обновлён (${members.length} участников, просмотры обновлены у ${fresh})`);
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
