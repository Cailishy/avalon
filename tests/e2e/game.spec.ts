import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { AudioPreferences } from "../../src/client/audio";
import { test, expect, type TestGame } from "./fixtures";

type Player = { name: string; id: string; context: BrowserContext; page: Page; role: string; good: boolean };

async function enter(browser: Browser, game: TestGame, count: number, beforeNavigation?: (page: Page, index: number) => Promise<void>): Promise<Player[]> {
  const players: Player[] = [];
  let roomCode = "";
  for (let index = 0; index < count; index++) {
    const context = await browser.newContext({ viewport: index === count - 1 ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: index === count - 1, reducedMotion: "reduce" });
    context.setDefaultTimeout(15000);
    // These multi-client flows exercise game state; audio has dedicated coverage.
    const quiet: Partial<AudioPreferences> = { music: false, narration: false, effects: false };
    await context.addInitScript(preferences => localStorage.setItem("awalong-audio", JSON.stringify(preferences)), quiet);
    if (index === count - 1) await context.addInitScript(() => { const now = Date.now.bind(Date); Date.now = () => now() + 8 * 3600000; });
    const response = await context.request.post(`${game.url}/api/access`, { data: { code: game.passcode } });
    expect(response.status()).toBe(200);
    const page = await context.newPage();
    await beforeNavigation?.(page, index);
    await page.goto(game.url);
    const name = `Test${String.fromCharCode(65 + index)}`;
    if (index === 0) {
      await page.getByRole("textbox", { name: "你的名字", exact: true }).fill(name);
      await page.getByRole("combobox", { name: "本局人数", exact: true }).selectOption(String(count));
      await page.getByRole("button", { name: "创建房间", exact: true }).click();
      await expect(page.locator(".game-container")).toHaveAttribute("data-phase", "lobby");
      roomCode = (await page.locator(".room-code").innerText()).replace("房间", "").trim();
    } else {
      await page.getByRole("tab", { name: "加入房间", exact: true }).click();
      await page.locator("#joinNameInput").fill(name); await page.locator("#roomInput").fill(roomCode);
      await page.getByRole("button", { name: "加入房间", exact: true }).click();
      await expect(page.locator(".game-container")).toHaveAttribute("data-phase", "lobby");
      await page.locator('[data-action="ready"]').click();
    }
    const card = page.locator(".player-card").filter({ has: page.locator(".player-name").getByText(name, { exact: true }) });
    const id = await card.getAttribute("data-player-id");
    expect(id).toBeTruthy();
    players.push({ name, id: id!, context, page, role: "", good: false });
  }
  await expect(players[0].page.locator('[data-action="start"]')).toBeEnabled();
  await players[0].page.locator('[data-action="start"]').click();
  await phase(players, "team");
  for (const player of players) {
    player.role = (await player.page.locator(".role-card-display .role-name").textContent()) ?? "";
    player.good = await player.page.locator(".role-card-display.good").count() === 1;
  }
  expect(players.every(player => !!player.role)).toBe(true);
  return players;
}

async function phase(players: Player[], value: string) {
  await Promise.all(players.map(player => expect(player.page.locator(".game-container")).toHaveAttribute("data-phase", value, { timeout: 20000 })));
}
async function actor(players: Player[], action: string): Promise<Player> {
  let found: Player | undefined;
  await expect.poll(async () => {
    for (const player of players) if (await player.page.locator(`[data-action="${action}"]`).isVisible()) { found = player; return true; }
    return false;
  }).toBe(true);
  return found!;
}
async function propose(players: Player[], quest: number, candidates: Player[]) {
  const leader = await actor(players, "propose");
  await leader.page.locator(`[data-quest-index="${quest}"]`).click();
  const size = Number.parseInt(await leader.page.locator(`[data-quest-index="${quest}"] strong`).innerText());
  const selected = candidates.slice(0, size);
  for (const player of selected) await leader.page.getByRole("button", { name: `选择 ${player.name}`, exact: true }).click();
  await leader.page.locator('[data-action="propose"]').click();
  await phase(players, "vote");
  await expect(leader.page.locator('[data-action="vote-yes"]')).toHaveCount(0);
  return { leader, selected };
}
async function endSpeeches(players: Player[]) {
  await phase(players, "speech");
  for (let index = 0; index < players.length; index++) {
    const speaker = await actor(players, "end-speech");
    await speaker.page.locator('[data-action="end-speech"]').click();
  }
  await phase(players, "team");
}
async function closePlayers(players: Player[]) { await Promise.all(players.map(player => player.context.close())); }

for (const count of [5, 6, 7, 8, 9, 10]) {
  test(`${count} players: proposal rejection, three missions, speech, assassination and restart`, async ({ browser, game }, info) => {
    const players = await enter(browser, game, count);
    try {
      const first = await propose(players, 0, players);
      for (const player of players.filter(player => player !== first.leader)) await player.page.locator('[data-action="vote-no"]').click();
      await phase(players, "proposalResult");
      await expect(players[0].page.locator(".proposal-outcome .vote-details")).toContainText(first.leader.name);
      await phase(players, "team");

      for (const quest of [3, 1, 0]) {
        const { leader, selected } = await propose(players, quest, players.filter(player => player.good));
        for (const player of players.filter(player => player !== leader)) await player.page.locator('[data-action="vote-yes"]').click();
        await phase(players, "mission");
        for (const player of selected) {
          await expect(player.page.locator('[data-action="mission-fail"]')).toBeDisabled();
          await player.page.locator('[data-action="mission-success"]').click();
        }
        await phase(players, "missionResult");
        await expect(players[0].page.locator(".mission-outcome h2")).toHaveText("任务成功");
        if (quest !== 0) await endSpeeches(players);
      }
      await phase(players, "assassin");
      const assassin = players.find(player => player.role.includes("刺客"))!;
      const merlin = players.find(player => player.role === "『梅林』")!;
      const target = count % 2 === 0 ? merlin : players.find(player => player.good && player !== merlin)!;
      await assassin.page.locator(`.player-card[data-player-id="${target.id}"]`).click();
      await assassin.page.locator('[data-action="assassinate"]').click();
      await phase(players, "result");
      for (const player of players) {
        await expect(player.page.locator(".settlement-heading h2")).toHaveText(count % 2 === 0 ? "藏锋者胜利" : "守誓者胜利");
        await expect(player.page.locator(".result-player")).toHaveCount(count);
      }
      await players[0].page.locator(".game-result-overlay").waitFor({ state: "detached" });
      await players[0].page.screenshot({ path: info.outputPath("desktop-result.jpg"), fullPage: true });
      await players.at(-1)!.page.screenshot({ path: info.outputPath("mobile-result.jpg"), fullPage: true });
      await players[0].page.locator('[data-action="restart"]').click();
      await phase(players, "lobby");
      await expect(players[0].page.locator(".role-card-display")).toHaveCount(0);
    } finally { await closePlayers(players); }
  });
}

test("weak network, lost acknowledgement, node retention, clock skew and process recovery", async ({ browser, game }, info) => {
  const attempts: string[] = [];
  const upgraded = new Set<string>();
  let voterName = "";
  let dropAck: string | null = null;
  const players = await enter(browser, game, 5, async (page, index) => {
    const name = `Test${String.fromCharCode(65 + index)}`;
    await page.routeWebSocket("**/socket.io/**", route => {
      upgraded.delete(name);
      const server = route.connectToServer();
      route.onMessage(message => {
        if (message === "5") upgraded.add(name);
        if (name === voterName && typeof message === "string") {
          const match = /^42(\d+)(\[.*)$/.exec(message);
          if (match) {
            const [event, payload] = JSON.parse(match[2]);
            if (event === "vote:submit") { attempts.push(payload.requestId); if (dropAck === null) dropAck = `43${match[1]}`; }
          }
        }
        server.send(message);
      });
      server.onMessage(message => {
        if (name === voterName && typeof message === "string" && dropAck && message.startsWith(`${dropAck}[`)) { dropAck = "dropped"; return; }
        route.send(message);
      });
    });
  });
  try {
    const leader = await actor(players, "propose");
    const other = players.find(player => player !== leader)!;
    const select = leader.page.getByRole("button", { name: `选择 ${leader.name}`, exact: true });
    await select.click(); await select.focus();
    const seat = await select.elementHandle();
    const table = await leader.page.locator(".table-surface").elementHandle();
    await other.context.setOffline(true);
    await expect(leader.page.locator(`.player-card[data-player-id="${other.id}"]`)).toHaveClass(/offline/);
    expect(await seat!.evaluate(node => node.isConnected)).toBe(true);
    expect(await table!.evaluate(node => node.isConnected)).toBe(true);
    await expect(select).toBeFocused(); await expect(select).toHaveAttribute("aria-pressed", "true");
    await leader.page.getByRole("button", { name: "游戏规则", exact: true }).click();
    const dialog = await leader.page.locator(".modal-content").elementHandle();
    await leader.page.locator("#rulePlayerCount").focus();
    await leader.page.locator(".modal-body").evaluate(node => { node.scrollTop = 150; });
    expect(await leader.page.locator(".modal-body").evaluate(node => node.scrollTop)).toBe(150);
    await other.context.setOffline(false);
    await expect(leader.page.locator(`.player-card[data-player-id="${other.id}"]`)).not.toHaveClass(/offline/);
    expect(await dialog!.evaluate(node => node.isConnected)).toBe(true);
    await expect(leader.page.locator("#rulePlayerCount")).toBeFocused();
    expect(await leader.page.locator(".modal-body").evaluate(node => node.scrollTop)).toBe(150);
    await leader.page.getByRole("button", { name: "关闭", exact: true }).click();
    await select.click(); await expect(select).toHaveAttribute("aria-pressed", "false");
    await players.at(-1)!.page.reload();
    await expect(players.at(-1)!.page.locator(".game-timer-time")).toHaveText(/0:[0-3]\d/);
    const proposal = await propose(players, 0, players);
    const voter = players.find(player => player !== proposal.leader)!;
    voterName = voter.name;
    await expect(voter.page.locator('[data-action="vote-yes"]')).toBeVisible();
    await expect.poll(() => upgraded.has(voter.name)).toBe(true);
    await voter.page.locator('[data-action="vote-yes"]').click();
    await expect.poll(() => attempts.length).toBeGreaterThan(0);
    await expect.poll(() => attempts.length, { timeout: 15000 }).toBeGreaterThan(1);
    expect(new Set(attempts).size).toBe(1);
    const beforeRestart = await voter.page.locator(".game-container").getAttribute("data-phase-id");
    await game.restart();
    for (const player of players) await expect(player.page.locator(".game-container")).not.toHaveAttribute("data-phase-id", beforeRestart!);
    await phase(players, "vote");
    for (const player of players.filter(player => player !== proposal.leader && player !== voter)) await player.page.locator('[data-action="vote-yes"]').click();
    await phase(players, "mission");
    for (const player of proposal.selected) await player.page.locator('[data-action="mission-success"]').click();
    await phase(players, "missionResult");
    await expect(players[0].page.locator(".history-entry.mission-success")).toHaveCount(1);
    await expect(players[0].page.locator(".history-entry.vote-approved")).toHaveCount(1);
    await players[0].page.screenshot({ path: info.outputPath("recovered-mission.jpg"), fullPage: true });
  } finally { await closePlayers(players); }
});
