'use strict';
// Actual public Market Radar component + actual shared module, isolated data.
// Usage: NODE_PATH=<consumer>/node_modules node tests/team-assess-consumer-browser.cjs <built-public-consumer> <artifact-dir>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('@playwright/test');
const consumer = path.resolve(process.argv[2]);
const artifacts = path.resolve(process.argv[3] || 'tmp/pick-consumer');
const shared = path.resolve(__dirname, '..');
const assets = {
  '/react.js': path.join(consumer, 'vendor/react.production.min.js'),
  '/react-dom.js': path.join(consumer, 'vendor/react-dom.production.min.js'),
  '/intelligence.js': path.join(consumer, 'reconai-shared/intelligence-context.js'),
  '/assess.js': path.join(consumer, 'reconai-shared/team-assess.js'),
  '/widget.js': path.join(consumer, 'dist-preview/compiled/js/widgets/market-radar.js'),
  '/theme.js': path.join(consumer, 'js/theme.js'),
};
assert.equal(fs.readFileSync(assets['/assess.js'], 'utf8'), fs.readFileSync(path.join(shared, 'team-assess.js'), 'utf8'), 'consumer must vendor the exact candidate');
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{background:#15171d;color:#fff;font:16px sans-serif;margin:20px}button{color:inherit}#root{max-width:1160px}#destination{margin:12px}</style></head><body>
<p>Controlled public component integration fixture — no connected accounts or provider calls.</p><div id="root"></div><div id="destination"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/theme.js"></script><script src="/intelligence.js"></script><script src="/assess.js"></script><script src="/widget.js"></script>
<script>
window.WR = { GmMode: { useGmEffects: () => ({ targetPositions: new Set(), marketPosture: 'hold' }) } };
window.dynastyValue = id => id === 'qb1' ? 9000 : 500;
window.renderFixture = (type, ownership, status = 'pre_draft') => {
  const rosters = [{roster_id:1,owner_id:'a',players:['qb1'],settings:{wins:2,losses:0}}, {roster_id:2,owner_id:'b',players:['qb2'],settings:{wins:0,losses:2}}];
  const users = [{user_id:'a',display_name:'Fixture Alpha'}, {user_id:'b',display_name:'Fixture Beta'}];
  const players = {qb1:{position:'QB',team:'KC',age:27,full_name:'Fixture Starter'},qb2:{position:'QB',team:'BUF',age:25,full_name:'Fixture Reserve'}};
  const league = {league_id:'fixture-league',season:'2026',status,settings:{type,draft_rounds:4},roster_positions:['QB','BN'],rosters,users};
  if (status === 'complete') league.drafts = [{draft_id:'fixture-draft',league_id:league.league_id,season:'2026',status:'complete'}];
  window.S = {currentLeagueId:league.league_id,season:league.season,leagues:[league],rosters,leagueUsers:users,players,playerStats:{qb1:{seasonAvg:25},qb2:{seasonAvg:1}},tradedPicks:ownership};
  window.App.LI = {builtAt:1,playerScores:{qb1:9000,qb2:500}};
  ReactDOM.unmountComponentAtNode(document.getElementById('root'));
  ReactDOM.render(React.createElement(window.MarketRadarWidget,{size:'xxl',myRoster:rosters[0],rankedTeams:[],sleeperUserId:'a',currentLeague:league,playersData:players,setActiveTab:tab=>{document.getElementById('destination').textContent=tab;}}),document.getElementById('root'));
};
window.renderFixture(0,[]);
</script></body></html>`;
(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  let browser;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const filename = assets[req.url];
    res.setHeader('Content-Type', (filename ? 'application/javascript' : 'text/html') + '; charset=utf-8');
    res.end(filename ? fs.readFileSync(filename) : html);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    const context = await browser.newContext({ viewport: { width: 1200, height: 780 } });
    const blocked = [], errors = [];
    await context.route('**/*', route => {
      const req = route.request();
      if (req.method() === 'GET' && new URL(req.url()).origin === origin) return route.continue();
      blocked.push(req.method() + ' ' + req.url()); return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'networkidle' });
    fs.writeFileSync(path.join(artifacts, 'initial-state.json'), JSON.stringify({ errors, text: await page.locator('body').innerText(), assessments: await page.evaluate(() => window.App?.assessAllTeamsFromGlobal?.() || []) }, null, 2));
    await page.getByText('sells vets · 4 picks', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Trades', exact: true }).click();
    assert.equal(await page.locator('#destination').innerText(), 'trades', 'existing consumer handoff remains usable');
    await page.evaluate(() => renderFixture(0, [{season:'2026',round:1,roster_id:2,owner_id:1}]));
    await page.getByText('sells vets · 3 picks', { exact: true }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('sells vets · 4 picks', { exact: true }).waitFor();
    await page.evaluate(() => renderFixture(0, null));
    await page.getByText('sells vets', { exact: true }).waitFor();
    assert.equal(await page.locator('#root').getByText(/\d+ picks/).count(), 0, 'missing feed is not rendered as zero/full capital');
    await page.screenshot({ path: path.join(artifacts, 'unknown-ownership.png') });
    await page.evaluate(() => renderFixture(0, [], 'complete'));
    await page.getByText('sells vets', { exact: true }).waitFor();
    await page.evaluate(() => renderFixture(2, [], 'complete'));
    await page.getByText('sells vets · 12 picks', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => App.assessAllTeamsFromGlobal()[1].picksAssessment.pickYears), ['2027', '2028', '2029']);
    assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
    const evidence = { consumer: 'actual public MarketRadarWidget', viewport: '1200x780', externalMutationGuard: true,
      checks: ['seasonal current-year count', 'changed ownership after reopening', 'saved-pin reload recovery', 'unknown feed without invented count', 'spent seasonal capital retired', 'completed dynasty accepted horizon', 'existing Trades handoff'], pageErrors: errors };
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify(evidence));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
