import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivatePlayerState, PublicRoomState } from "../shared/game";

const { socket, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    connected: true,
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler)),
  };
  return { socket, handlers };
});

vi.mock("socket.io-client", () => ({ io: () => socket }));
vi.mock("./icons", () => ({ icon: () => "" }));
vi.mock("./domRenderer", async importOriginal => ({
  ...await importOriginal<typeof import("./domRenderer")>(),
  patchHtml: (root: HTMLElement, html: string) => { root.innerHTML = html; },
}));

const sessionKey = "awalong-lan-session";
const identity = { roomCode: "ABCDE", playerId: "p-self", sessionToken: "s-self", name: "Player" };
let storage: Map<string, string>;
let app: ReturnType<typeof createElement>;
let rejoinClick: (() => void) | undefined;

function createElement() {
  return {
    innerHTML: "",
    className: "",
    querySelector: vi.fn((_selector: string): object | null => null),
    querySelectorAll: vi.fn(() => []),
    setAttribute: vi.fn(),
    remove: vi.fn(),
    classList: { add: vi.fn() },
  };
}

function roomState(): PublicRoomState {
  return {
    phaseId: `phase_${"a".repeat(32)}`,
    roomCode: identity.roomCode,
    phase: "lobby",
    players: [
      { id: "p-host", name: "Host", isHost: true, connected: true, position: 0, ready: false },
      { id: identity.playerId, name: identity.name, isHost: false, connected: true, position: 1, ready: false },
      ...Array.from({ length: 3 }, (_, index) => ({ id: `p${index + 3}`, name: `P${index + 3}`, isHost: false, connected: true, position: index + 2, ready: true })),
    ],
    hostId: "p-host",
    targetPlayerCount: 5,
    localUrls: [],
    leaderId: null,
    questIndex: 0,
    teamSize: 0,
    requiredFails: 0,
    rejectCount: 0,
    score: { success: 0, fail: 0 },
    proposal: [],
    voteSubmitted: [],
    missionSubmitted: [],
    history: [],
    winner: null,
    winnerReason: "",
    revealedRoles: [],
    servantCounts: null,
    speechOrder: [],
    timer: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  handlers.clear();
  socket.emit.mockReset();
  socket.connected = true;
  rejoinClick = undefined;
  storage = new Map([[sessionKey, JSON.stringify(identity)]]);
  app = createElement();
  vi.stubGlobal("document", {
    querySelector: (selector: string) => selector === "#app" ? app : null,
    querySelectorAll: () => [],
    createElement,
    body: { appendChild: vi.fn() },
  });
  vi.stubGlobal("window", {
    location: { search: "", origin: "http://localhost:3000", reload: vi.fn() },
    setTimeout,
    clearTimeout,
    setInterval,
    requestAnimationFrame: vi.fn(() => 1),
    addEventListener: vi.fn(),
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["vote", "reveal", "proposalResult", "missionResult"] as const)("renders %s recovery as paused without game buttons or result animations", async phase => {
  await import("./main");
  const state = roomState();
  state.phase = phase;
  state.history = phase === "missionResult" ? [{ type: "mission", quest: 1, team: ["p-host", identity.playerId], fails: 0, result: "success" }] : [{ type: "vote", quest: 1, team: ["p-host", identity.playerId], approvals: 1, rejections: 4 }];
  state.recovery = { deadline: Date.now() + 60000, connected: 1, expected: 5 };
  state.timer = { kind: "recovery", label: "等待玩家恢复连接", deadline: state.recovery.deadline, durationMs: 60000 };
  handlers.get("room:state")!(state);
  expect(app.innerHTML).toContain("对局恢复中");
  expect(app.innerHTML).toContain("1 / 5 位玩家已恢复连接");
  expect(app.innerHTML).not.toContain('data-action="vote-yes"');
  expect(app.innerHTML).not.toContain('data-action="vote-no"');
  expect(app.innerHTML).toContain('aria-label="圆桌座位"');
  expect(app.innerHTML).toContain("等待重连");
  expect(app.innerHTML).not.toContain('class="round-table mission-outcome');
  expect(app.innerHTML).not.toContain('class="round-table proposal-outcome');
});

it("resumes role reveal with its remaining time only after recovery ends", async () => {
  await import("./main");
  const state: PublicRoomState = { ...roomState(), phase: "reveal", recovery: { deadline: Date.now() + 60000, connected: 1, expected: 5 }, timer: { kind: "recovery", label: "等待玩家恢复连接", deadline: Date.now() + 60000, durationMs: 60000 } };
  handlers.get("room:state")!(state);
  handlers.get("player:privateState")!(privatePlayer());
  const append = document.body.appendChild as ReturnType<typeof vi.fn>;
  expect(append).not.toHaveBeenCalled();
  handlers.get("room:state")!({ ...state, recovery: undefined, timer: { kind: "reveal", label: "身份揭晓", deadline: Date.now() + 4000, durationMs: 10000 } });
  expect(append).toHaveBeenCalledOnce();
  expect(append.mock.calls[0][0].innerHTML).toContain("4 秒");
});

describe("Client session recovery", () => {
  it("keeps a valid identity after a recoverable rejoin error and re-enables unchanged controls once sync confirms it", async () => {
    await import("./main"); handlers.get("room:state")!(roomState());
    socket.connected = false; handlers.get("disconnect")!("transport close");
    socket.emit.mockImplementation((event, _payload, ack) => {
      if (event === "room:rejoin") ack({ ok: false, error: "服务暂时不可用。" });
      if (event === "room:sync") ack({ ok: true });
    });
    socket.connected = true; handlers.get("connect")!();
    expect(storage.has(sessionKey)).toBe(true);
    expect(app.innerHTML).toContain("game-container");
    vi.advanceTimersByTime(1500);
    expect(storage.has(sessionKey)).toBe(true);
    expect(app.innerHTML).not.toMatch(/data-action="ready" disabled/);
  });

  it("returns to server entrance verification without deleting the saved player session", async () => {
    await import("./main");
    handlers.get("connect_error")!({ data: { code: "ACCESS_REQUIRED" } });
    expect(window.location.reload).toHaveBeenCalledOnce();
    expect(storage.has(sessionKey)).toBe(true);
    handlers.get("access:required")!();
    expect(window.location.reload).toHaveBeenCalledTimes(2);
  });
  it("returns to the landing page and stops syncing the old identity after failed reconnect", async () => {
    await import("./main");
    handlers.get("room:state")!(roomState());
    expect(app.innerHTML).toContain("game-container");
    socket.connected = false;
    handlers.get("disconnect")!("transport close");
    socket.emit.mockImplementation((event, _payload, ack) => {
      if (event === "room:rejoin") ack({ ok: false, error: "Room does not exist" });
    });

    socket.connected = true;
    handlers.get("connect")!();

    expect(storage.has(sessionKey)).toBe(false);
    expect(app.innerHTML).toContain('id="nameInput"');
    expect(app.innerHTML).not.toContain("game-container");
    vi.advanceTimersByTime(10_000);
    expect(socket.emit.mock.calls.some(([event]) => event === "room:sync")).toBe(false);
  });

  it("restores enabled lobby controls after successful reconnect with unchanged room state", async () => {
    await import("./main");
    handlers.get("room:state")!(roomState());
    socket.connected = false;
    handlers.get("disconnect")!("transport close");
    expect(app.innerHTML).toMatch(/data-action="ready" disabled/);
    socket.emit.mockImplementation((_event, _payload, ack) => ack({ ok: true }));

    socket.connected = true;
    handlers.get("connect")!();

    expect(storage.has(sessionKey)).toBe(true);
    expect(app.innerHTML).toContain("game-container");
    expect(app.innerHTML).not.toMatch(/data-action="ready" disabled/);
  });

  it("clears an invalid saved session when manually rejoining from the landing page", async () => {
    app.querySelector.mockImplementation((selector) => selector === "[data-action='rejoin']" ? {
      addEventListener: (_event: string, callback: () => void) => { rejoinClick = callback; },
    } : null);
    await import("./main");
    socket.emit.mockImplementation((_event, _payload, ack) => ack({ ok: false, error: "Session expired" }));
    expect(rejoinClick).toBeDefined();

    rejoinClick!();
    vi.advanceTimersByTime(520);

    expect(storage.has(sessionKey)).toBe(false);
    expect(app.innerHTML).toContain('id="nameInput"');
    expect(app.innerHTML).not.toContain('data-action="rejoin"');
  });
});

function privatePlayer(overrides: Partial<PrivatePlayerState> = {}): PrivatePlayerState {
  return {
    playerId: identity.playerId, role: "servant", roleName: "亚瑟忠臣", side: "good",
    servantVariant: "male",
    roleText: "忠臣", knowledge: "私密信息测试", canPropose: false, canVote: false,
    canMission: false, canFailMission: false, canAssassinate: false, ...overrides,
  };
}

describe("Table theme phase controls", () => {
  it.each([[3, 0, "对局结算"], [0, 3, "藏锋者密议"]] as const)("announces the correct terminal destination for fail=%i success=%i", async (fail, success, destination) => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "missionResult", score: { fail, success } });
    expect(app.innerHTML).toContain(`下一阶段 · ${destination}`);
    expect(app.innerHTML).not.toContain('下一阶段 · 轮流发言');
  });

  it("shows disclosed evil identities and a two-minute timer to observers without assassination controls", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "assassin", timer: { kind: "assassin", label: "藏锋者讨论与刺杀", durationMs: 120_000, deadline: Date.now() + 120_000 }, revealedRoles: [
      { playerId: "p-host", role: "assassin", roleName: "刺客", side: "evil", servantVariant: null },
      { playerId: "p3", role: "morgana", roleName: "莫甘娜", side: "evil", servantVariant: null },
    ] });
    handlers.get("player:privateState")!(privatePlayer());
    expect(app.innerHTML).toContain('藏锋者已亮明身份');
    expect(app.innerHTML).toContain('讨论与刺杀 · 2 分钟');
    expect(app.innerHTML).toContain('class="game-timer-time">2:00');
    expect(app.innerHTML).toContain('data-disclosed-player="p-host"');
    expect(app.innerHTML).toContain('data-disclosed-player="p3"');
    expect(app.innerHTML).toContain('class="player-status">『莫甘娜』</div>');
    expect(app.innerHTML).not.toContain('data-action="assassinate"');
    expect(app.innerHTML).not.toContain('aria-label="发言顺序"');
  });

  it("prevents the assassin from targeting themselves or disclosed allies", async () => {
    const clicks = new Map<string, () => void>();
    const cards = [identity.playerId, "p-host", "p3"].map(playerId => ({ dataset: { playerId }, addEventListener: (event: string, callback: () => void) => { if (event === "click") clicks.set(playerId, callback); } }));
    app.querySelectorAll.mockImplementation((...args: unknown[]) => args[0] === ".player-card" ? cards as never[] : []);
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "assassin", revealedRoles: [
      { playerId: identity.playerId, role: "assassin", roleName: "刺客", side: "evil", servantVariant: null },
      { playerId: "p-host", role: "morgana", roleName: "莫甘娜", side: "evil", servantVariant: null },
    ] });
    handlers.get("player:privateState")!(privatePlayer({ role: "assassin", side: "evil", canAssassinate: true }));
    clicks.get(identity.playerId)!();
    clicks.get("p-host")!();
    expect(app.innerHTML).toContain('尚未选择目标');
    clicks.get("p3")!();
    expect(app.innerHTML).toContain('已选 P3');
    expect(socket.emit).not.toHaveBeenCalled();
  });
  it("places game-end text inside the centered settlement heading and uses faction names", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "result", winner: "evil", winnerReason: "三个任务失败，反方获胜。", score: { success: 2, fail: 3 } });
    const heading = app.innerHTML.split('class="settlement-heading evil">')[1].split('</header>')[0];
    expect(heading).toContain('<p class="settlement-kicker">游戏结束</p>');
    expect(heading).toContain('<h2>藏锋者胜利</h2>');
    expect(heading).toContain('三个任务失败，藏锋者获胜。');
    expect(app.innerHTML).not.toContain('<div class="action-title">游戏结束</div>');
  });

  it.each([[0, 1], [1, 0], [2, 2]])("shows aggregate male/female servant counts (%i/%i), including zero", async (male, female) => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "team", servantCounts: { male, female } });
    const config = app.innerHTML.split('aria-label="本局身份">')[1].split('class="role-panel')[0];
    expect(config).toContain(`『亚瑟的忠臣（男性）』 ${male} 人，查看角色`);
    expect(config).toContain(`『亚瑟的忠臣（女性）』 ${female} 人，查看角色`);
    expect(config).not.toContain(identity.playerId);
  });

  it.each(["success", "fail"] as const)("opens completed %s mission details from public history and closes on restart", async result => {
    let open: (() => void) | undefined;
    const marker = { dataset: { questDetail: "1" }, addEventListener: (event: string, callback: () => void) => { if (event === "click") open = callback; } };
    app.querySelectorAll.mockImplementation((...args: unknown[]) => args[0] === "[data-quest-detail]" ? [marker] as never[] : []);
    await import("./main");
    const state = { ...roomState(), phase: "team" as const, history: [
      { type: "vote" as const, quest: 2, leader: "p-host", team: [identity.playerId, "p3"], approvals: 2, rejections: 3, result: "fail" as const },
      { type: "vote" as const, quest: 2, leader: identity.playerId, team: [identity.playerId, "p3"], approvals: 4, rejections: 1, result: "success" as const, voteDetails: [{ playerId: identity.playerId, approved: true }, { playerId: "p3", approved: false }] },
      { type: "mission" as const, quest: 2, leader: identity.playerId, team: [identity.playerId, "p3"], result, fails: result === "success" ? 0 : 1 },
    ] };
    state.players[2].name = '反方<script>';
    handlers.get("room:state")!(state);
    expect(app.innerHTML).toContain('type="button" data-quest-detail="1" aria-haspopup="dialog"');
    expect(app.innerHTML).not.toContain('data-quest-info');
    open!();
    const modal = app.innerHTML.split('class="modal-content quest-detail-modal"')[1];
    expect(modal).toContain('<h2>任务 2 详情</h2>');
    expect(modal).toContain('发车队长');
    expect(modal).toContain('上车队员');
    expect(modal).toContain('赞成 <strong>4</strong> 票');
    expect(modal).toContain('反对 <strong>1</strong> 票');
    expect(modal).toContain('反方&lt;script&gt;');
    expect(modal).toContain('队长 Player · 自动赞成');
    expect(modal).toContain('任务牌结果');
    expect(modal).not.toContain('portrait-guest');
    expect(modal).not.toContain('<script>');
    handlers.get("room:state")!({ ...state, leaderId: "p3" });
    expect(app.innerHTML).toContain('<h2>任务 2 详情</h2>');
    handlers.get("room:state")!(roomState());
    expect(app.innerHTML).not.toContain('quest-detail-modal');
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("shows forced launch exemption in quest details without invented voting totals", async () => {
    let open: (() => void) | undefined;
    const marker = { dataset: { questDetail: "0" }, addEventListener: (event: string, callback: () => void) => { if (event === "click") open = callback; } };
    app.querySelectorAll.mockImplementation((...args: unknown[]) => args[0] === "[data-quest-detail]" ? [marker] as never[] : []);
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "result", winner: "evil", history: [
      { type: "vote", quest: 1, leader: "p-host", team: [identity.playerId], approvals: 0, rejections: 0, forced: true, result: "success" },
      { type: "mission", quest: 1, leader: "p-host", team: [identity.playerId], fails: 1, result: "fail" },
    ] });
    open!();
    const modal = app.innerHTML.split('class="modal-content quest-detail-modal"')[1];
    expect(modal).toContain('强制发车 · 本次免表决');
    expect(modal).not.toContain('赞成 <strong>0</strong> 票');
    expect(modal).not.toContain('队伍表决明细');
  });

  it("does not open details for an unfinished quest", async () => {
    let open: (() => void) | undefined;
    const marker = { dataset: { questDetail: "0" }, addEventListener: (event: string, callback: () => void) => { if (event === "click") open = callback; } };
    app.querySelectorAll.mockImplementation((...args: unknown[]) => args[0] === "[data-quest-detail]" ? [marker] as never[] : []);
    await import("./main");
    handlers.get("room:state")!(roomState());
    open!();
    expect(app.innerHTML).not.toContain('quest-detail-modal');
    expect(app.innerHTML).not.toContain('data-quest-detail="0"');
  });
  it("removes the old landing subtitle", async () => {
    storage.delete(sessionKey);
    await import("./main");
    expect(app.innerHTML).toContain('<h1>阿瓦隆</h1>');
    expect(app.innerHTML).not.toContain('圆桌之上，各有立场');
    expect(app.innerHTML).not.toContain('class="subtitle"');
  });
  it.each(["male", "female"] as const)("uses the server's %s servant art in reveal, identity panel and own-role details", async servantVariant => {
    let open: (() => void) | undefined;
    app.querySelector.mockImplementation(selector => selector === "[data-action='show-own-role']" ? { addEventListener: (event: string, callback: () => void) => { if (event === "click") open = callback; } } : null);
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "reveal", timer: { kind: "reveal", label: "身份揭晓", deadline: Date.now() + 10_000, durationMs: 10_000 } });
    handlers.get("player:privateState")!(privatePlayer({ servantVariant }));
    const append = document.body.appendChild as ReturnType<typeof vi.fn>;
    const overlay = append.mock.calls[0][0].innerHTML as string;
    const ownPanel = app.innerHTML.split('class="role-card-display')[1].split('role-knowledge')[0];
    expect(overlay.includes('portrait-guest reveal-art')).toBe(servantVariant === "female");
    expect(ownPanel.includes('portrait-guest role-art')).toBe(servantVariant === "female");
    const seats = app.innerHTML.split('aria-label="圆桌座位">')[1].split('<aside')[0];
    expect(seats).not.toContain('portrait-guest');
    open!();
    expect(app.innerHTML).toContain(`<h2>『亚瑟的忠臣${servantVariant === "female" ? "（女性）" : ""}』</h2>`);
    handlers.get("player:privateState")!(privatePlayer({ servantVariant }));
    expect(app.innerHTML).toContain(`<h2>『亚瑟的忠臣${servantVariant === "female" ? "（女性）" : ""}』</h2>`);
  });

  it("uses final public servant appearance for the settlement portrait", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "result", winner: "evil", revealedRoles: [{ playerId: identity.playerId, role: "servant", roleName: "亚瑟忠臣", side: "good", servantVariant: "female" }] });
    const roster = app.innerHTML.split('class="result-roster">')[1].split('</div>\n')[0];
    expect(roster).toContain('portrait-guest roster-art');
  });

  it("shows literal approval and rejection names on rejection and keeps an expandable history record", async () => {
    let toggle: (() => void) | undefined;
    const details = { dataset: { voteRecord: "0" }, open: false, addEventListener: (_: string, callback: () => void) => { toggle = callback; } };
    app.querySelectorAll.mockImplementation((...args: unknown[]) => args[0] === "[data-vote-record]" ? [details] as never[] : []);
    await import("./main");
    const state = roomState();
    state.players[2].name = "梅林<script>";
    const entry = { type: "vote" as const, quest: 1, leader: "p-host", team: [identity.playerId, "p3"], approvals: 2, rejections: 3, result: "fail" as const, voteDetails: [
      { playerId: "p5", approved: false }, { playerId: "p3", approved: false }, { playerId: identity.playerId, approved: true }, { playerId: "p4", approved: false }, { playerId: "p-host", approved: true },
    ] };
    handlers.get("room:state")!({ ...state, phase: "proposalResult", history: [entry], timer: { kind: "proposalResult", label: "发车结果", deadline: Date.now() + 5_000, durationMs: 5_000 } });
    const outcome = app.innerHTML.split('aria-label="发车结果"')[1].split('</section>\n')[0];
    const approvals = outcome.split('aria-label="赞成名单"')[1].split('aria-label="反对名单"')[0];
    const rejections = outcome.split('aria-label="反对名单"')[1];
    expect(approvals).toContain('class="vote-voter-name">Player</span>');
    expect(approvals.indexOf('>Host</span>')).toBeLessThan(approvals.indexOf('>Player</span>'));
    expect(rejections).toContain('class="vote-voter-name">梅林&lt;script&gt;</span>');
    expect(outcome).toContain('队长 Host · 自动赞成');
    expect(app.innerHTML).toContain('下一阶段 · 下一位队长组队');
    expect(app.innerHTML).not.toContain('下一阶段 · 轮流发言');
    expect(outcome).not.toContain('『梅林』&lt;script&gt;');
    expect(outcome).not.toContain('portrait-guest');
    expect(app.innerHTML).toContain('data-vote-record="0"');
    details.open = true;
    toggle!();
    handlers.get("room:state")!({ ...state, phase: "team", history: [entry], leaderId: identity.playerId });
    expect(app.innerHTML).toContain('data-vote-record="0" open');
    expect(app.innerHTML).toContain('梅林&lt;script&gt;');
  });

  it("does not expose an unfinished vote or any individual mission card", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "vote", voteSubmitted: ["p3"] });
    expect(app.innerHTML).not.toContain('aria-label="队伍表决明细"');
    handlers.get("room:state")!({ ...roomState(), phase: "missionResult", history: [{ type: "mission", quest: 1, team: ["p3", "p4"], result: "fail", fails: 1 }] });
    expect(app.innerHTML).not.toContain('aria-label="队伍表决明细"');
    expect(app.innerHTML).not.toContain('data-vote-record');
  });

  it("includes the captain in vote progress without rendering vote buttons for them", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "vote", leaderId: identity.playerId, voteSubmitted: [identity.playerId], proposal: [identity.playerId, "p3"] });
    handlers.get("player:privateState")!(privatePlayer());
    expect(app.innerHTML).toContain('1 / 5 已投票');
    expect(app.innerHTML).toContain('已自动投赞成票');
    expect(app.innerHTML).not.toContain('data-action="vote-yes"');
    expect(app.innerHTML).not.toContain('data-action="vote-no"');
  });

  it("renders the server selection deadline and removes draft controls after the captain changes", async () => {
    await import("./main");
    const state = { ...roomState(), phase: "team" as const, leaderId: identity.playerId, timer: { kind: "team" as const, label: "队长组队", durationMs: 30_000, deadline: Date.now() + 30_000 } };
    handlers.get("room:state")!(state);
    handlers.get("player:privateState")!(privatePlayer({ canPropose: true }));
    expect(app.innerHTML).toContain(`data-timer-deadline="${state.timer.deadline}"`);
    expect(app.innerHTML).toContain('data-action="propose"');
    handlers.get("room:state")!({ ...state, leaderId: "p3", timer: { ...state.timer, deadline: state.timer.deadline + 30_000 } });
    expect(app.innerHTML).not.toContain('data-action="propose"');
    expect(app.innerHTML).not.toContain('class="team-candidates"');
    expect(app.innerHTML).toContain(`data-timer-deadline="${state.timer.deadline + 30_000}"`);
  });

  it("labels the private role and ability text without labelling or trusting player nicknames", async () => {
    await import("./main");
    const state = roomState();
    state.players[0].name = "梅林<script>";
    handlers.get("room:state")!({ ...state, phase: "team" });
    handlers.get("player:privateState")!(privatePlayer({ role: "percival", roleName: "派西维尔", roleText: "知道谁可能是梅林，但莫甘娜会伪装成梅林。", knowledge: "你看到的梅林候选：梅林<script>、刺客。" }));
    expect(app.innerHTML).toContain('class="role-name">『派西维尔』</div>');
    expect(app.innerHTML).toContain('知道谁可能是『梅林』，但『莫甘娜』会伪装成『梅林』。');
    expect(app.innerHTML).toContain('你看到的『梅林？』：梅林&lt;script&gt;、刺客。');
    expect(app.innerHTML).toContain('class="player-name">梅林&lt;script&gt;</div>');
    expect(app.innerHTML).not.toContain("<script>");
  });

  it("labels rules role names and references while keeping navigation values raw", async () => {
    let open: (() => void) | undefined;
    app.querySelector.mockImplementation(selector => selector === "[data-action='show-rules']" ? {
      addEventListener: (_: string, callback: () => void) => { open = callback; },
    } : null);
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), targetPlayerCount: 7 });
    open!();
    expect(app.innerHTML).toContain('data-role="亚瑟的忠臣 x2"');
    expect(app.innerHTML).toContain('『亚瑟的忠臣』 x2');
    expect(app.innerHTML).toContain('data-role="莫德雷德"');
    expect(app.innerHTML).not.toContain('data-role="莫德雷德的爪牙"');
    expect(app.innerHTML).toContain('由『刺客』提交目标，命中『梅林』则藏锋者翻盘');
    expect(app.innerHTML).toContain('『梅林』被刺杀时，游戏立即结束');
    const important = app.innerHTML.split('<ul class="important-rules">')[1].split('</ul>')[0];
    expect(important).toContain('<li>守誓者在任务中只能打出成功牌</li>');
    expect(important).not.toContain('第4轮');
    expect(important).not.toContain('2张反对');
    expect(important).not.toContain('结果展示后直接刺杀');
    expect(important).not.toContain('不是立即执行刺杀');
    expect(important).toContain('<li><strong>终局流程：</strong>');
    expect(important).toContain('由藏锋者在2分钟内讨论，再由『刺客』选择目标并提交');
    expect(important).toContain('<li><strong>发言顺序：</strong>');
    expect(important).toContain('发言顺序为 C、D、E、A、B');
    expect(important).toContain('只有进入刺杀阶段后，『刺客』才可选择并提交');
    expect(app.innerHTML).toContain('至少2张反对（失败）任务牌才失败，1张反对仍成功');
    expect(app.innerHTML).toMatch(/<li class="good-text"><strong>守誓者胜利：<\/strong>\s*<div>•/);
    expect(app.innerHTML).not.toContain('（刺杀未命中或超时未提交）');
    expect(app.innerHTML).toMatch(/<li class="evil-text"><strong>藏锋者胜利：<\/strong>\s*<div>•/);
  });

  it.each(["reveal", "team", "vote", "mission", "speech", "result"] as const)("never shows assassination targets or controls during %s, even with stale private permission", async phase => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase, leaderId: "p-host" });
    handlers.get("player:privateState")!(privatePlayer({ role: "assassin", roleName: "刺客", side: "evil", canAssassinate: true }));
    expect(app.innerHTML).not.toContain('data-action="assassinate"');
    expect(app.innerHTML).not.toMatch(/data-player-id="[^"]+" role="button"/);
  });

  it("labels final identities and the victory overlay while keeping the target nickname literal", async () => {
    await import("./main");
    const state = roomState();
    state.players[0].name = "刺客";
    handlers.get("room:state")!({ ...state, phase: "team" });
    handlers.get("room:state")!({ ...state, phase: "result", winner: "good", winnerReason: "刺客选择了 刺客，梅林安全。", revealedRoles: [
      { playerId: "p-host", role: "servant", roleName: "亚瑟忠臣", side: "good" },
    ] });
    expect(app.innerHTML).toContain('<strong>刺客</strong><span>『亚瑟忠臣』</span>');
    expect(app.innerHTML).toContain('『刺客』选择了 刺客，『梅林』安全。');
    expect(app.innerHTML).toContain('class="player-status">『亚瑟忠臣』</div>');
    const append = document.body.appendChild as ReturnType<typeof vi.fn>;
    expect(append.mock.calls[0][0].innerHTML).toContain('『刺客』选择了 刺客，『梅林』安全。');
  });

  it("shares selection and deselection between table seats and candidate buttons", async () => {
    const clicks = new Map<string, () => void>();
    const cards = roomState().players.map(p => ({ dataset: { playerId: p.id }, addEventListener: (_: string, cb: () => void) => clicks.set(`seat-${p.id}`, cb) }));
    const buttons = roomState().players.map(p => ({ dataset: { teamPlayer: p.id }, addEventListener: (_: string, cb: () => void) => clicks.set(`candidate-${p.id}`, cb) }));
    app.querySelectorAll.mockImplementation((...args: unknown[]) => args[0] === ".player-card" ? cards as never[] : args[0] === "[data-team-player]" ? buttons as never[] : []);
    await import("./main");
    const state = { ...roomState(), phase: "team" as const, leaderId: identity.playerId, teamSize: 2 };
    handlers.get("room:state")!(state);
    handlers.get("player:privateState")!(privatePlayer({ canPropose: true }));
    clicks.get("candidate-p3")!();
    clicks.get("seat-p-host")!();
    expect(app.innerHTML).toContain('data-team-player="p3" aria-label="选择 P3" aria-pressed="true"');
    expect(app.innerHTML).toContain('data-team-player="p-host" aria-label="选择 Host" aria-pressed="true"');
    expect(app.innerHTML).toContain("已选 2 / 2 人");
    clicks.get("candidate-p4")!();
    expect(app.innerHTML).toContain('data-team-player="p4" aria-label="选择 P4" aria-pressed="false"');
    clicks.get("seat-p3")!();
    expect(app.innerHTML).toContain('data-team-player="p3" aria-label="选择 P3" aria-pressed="false"');
    expect(app.innerHTML).toContain("已选 1 / 2 人");
    handlers.get("room:state")!({ ...state, players: state.players.map(p => p.id === "p-host" ? { ...p, connected: false } : p) });
    clicks.get("candidate-p-host")!();
    expect(app.innerHTML).toContain("已选 0 / 2 人");
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("hides the candidate picker from other players and removes seat numbers", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "team", leaderId: "p-host" });
    handlers.get("player:privateState")!(privatePlayer({ canPropose: true }));
    expect(app.innerHTML).not.toContain("team-candidates");
    expect(app.innerHTML).not.toContain("seat-number");
    expect(app.innerHTML).not.toContain("1 · 你");
    expect(app.innerHTML).toContain('class="seat-self">你');
  });

  it.each([[4, 0], [2, 2], [8, 1], [0, 4]])("keeps both vote counts readable for %i approvals and %i rejections", async (approvals, rejections) => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "speech", history: [{ type: "vote", quest: 1, team: [identity.playerId], approvals, rejections, result: rejections === 0 ? "success" : undefined }] });
    expect(app.innerHTML).toContain(`aria-label="赞成 ${approvals} 票，反对 ${rejections} 票"`);
    expect(app.innerHTML).toContain(`赞成 <strong>${approvals}</strong>`);
    expect(app.innerHTML).toContain(`反对 <strong>${rejections}</strong>`);
    expect(app.innerHTML).not.toContain("vote-bar-label");
    const bar = app.innerHTML.split('class="history-vote-bar"')[1].split('</div></div>')[0];
    expect(bar).not.toContain("赞成");
    expect(bar).not.toContain("反对");
  });

  it("shows server speech order CDEAB and lets B propose only after the speech phase", async () => {
    await import("./main");
    const order = ["p3", "p4", "p5", "p-host", identity.playerId];
    const state = { ...roomState(), phase: "speech" as const, leaderId: identity.playerId, speechOrder: order, timer: { kind: "speech" as const, label: "P3 发言", deadline: Date.now() + 60_000, durationMs: 60_000, speakerId: "p3" } };
    handlers.get("room:state")!(state);
    handlers.get("player:privateState")!(privatePlayer());
    const roster = app.innerHTML.split('aria-label="发言顺序">')[1].split('</ol>')[0];
    const indexes = ["P3", "P4", "P5", "Host", "Player"].map(name => roster.indexOf(`<span>${name}</span>`));
    expect(indexes.every((index, i) => i === 0 || index > indexes[i - 1])).toBe(true);
    expect(app.innerHTML).toContain("下一位队长");
    expect(app.innerHTML).not.toContain('data-action="propose"');
    expect(app.innerHTML).not.toContain('data-action="end-speech"');
    handlers.get("room:state")!({ ...state, timer: { ...state.timer, speakerId: identity.playerId } });
    expect(app.innerHTML).toContain('data-action="end-speech"');
    expect(app.innerHTML).toContain("5 / 5");
    handlers.get("room:state")!({ ...state, phase: "team", speechOrder: [], timer: null });
    handlers.get("player:privateState")!(privatePlayer({ canPropose: true }));
    expect(app.innerHTML).toContain("team-candidates");
  });

  it.each([5, 6, 7, 8, 9, 10])("shows public configuration for a %i-player lobby before the private role panel", async count => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), targetPlayerCount: count });
    const config = app.innerHTML.split('aria-label="本局身份">')[1].split('<section class="role-panel lobby-info">')[0];
    expect(config).toContain(`${count} 人局`);
    expect(config).toContain('data-servant-variant="male" aria-label="『亚瑟的忠臣（男性）』 待分配，查看角色"');
    expect(config).toContain('data-servant-variant="female" aria-label="『亚瑟的忠臣（女性）』 待分配，查看角色"');
    expect(config).toContain('data-role-detail="亚瑟忠臣"');
    expect(config).toContain('portrait configuration-art');
    expect(config).not.toContain(identity.playerId);
    expect(config).not.toContain(identity.name);
    expect(config).toContain('portrait-guest configuration-art');
    expect(app.innerHTML.indexOf('aria-label="本局身份"')).toBeLessThan(app.innerHTML.indexOf('class="role-panel lobby-info"'));
  });

  it("updates lobby configuration from snapshots and preserves game counts when someone goes offline", async () => {
    await import("./main");
    handlers.get("room:state")!(roomState());
    expect(app.innerHTML).toContain("5 人局 · 5 种身份");
    handlers.get("room:state")!({ ...roomState(), targetPlayerCount: 10 });
    expect(app.innerHTML).toContain("10 人局 · 7 种身份");
    const players = [...roomState().players, ...Array.from({ length: 5 }, (_, index) => ({ id: `extra-${index}`, name: `P${index + 6}`, isHost: false, connected: index !== 0, position: index + 5, ready: true }))];
    handlers.get("room:state")!({ ...roomState(), phase: "team", players, targetPlayerCount: 10, servantCounts: { male: 1, female: 3 } });
    expect(app.innerHTML).toContain("10 人局 · 7 种身份");
    expect(app.innerHTML).toContain('data-servant-variant="male" aria-label="『亚瑟的忠臣（男性）』 1 人，查看角色"');
    expect(app.innerHTML).toContain('data-servant-variant="female" aria-label="『亚瑟的忠臣（女性）』 3 人，查看角色"');
    expect(app.innerHTML).toContain('aria-label="守誓者身份配置"');
    expect(app.innerHTML).toContain('aria-label="藏锋者身份配置"');
  });

  it("uses actual game size rather than the lobby target for an active configuration", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "team", targetPlayerCount: 10 });
    expect(app.innerHTML).toContain("5 人局 · 5 种身份");
    expect(app.innerHTML).not.toContain("10 人局");
  });

  it("opens public role cards from the compact configuration without sending a game action", async () => {
    const clicks = new Map<string, () => void>();
    app.querySelector.mockImplementation(selector => selector === "[data-action='toggle-role-configuration']" ? {
      addEventListener: (_: string, callback: () => void) => clicks.set("toggle", callback),
    } : null);
    const card = { dataset: { roleDetail: "梅林" }, addEventListener: (_: string, callback: () => void) => clicks.set("role", callback) };
    const close = { addEventListener: (_: string, callback: () => void) => clicks.set("close", callback) };
    app.querySelectorAll.mockImplementation((...args: unknown[]) => args[0] === "[data-role-detail]" ? [card] as never[] : args[0] === "[data-action='close-modal']" ? [close] as never[] : []);
    await import("./main");
    handlers.get("room:state")!(roomState());
    clicks.get("toggle")!();
    expect(app.innerHTML).toContain('role-configuration-content expanded');
    handlers.get("room:state")!({ ...roomState(), players: roomState().players.map(player => ({ ...player, ready: true })) });
    expect(app.innerHTML).toContain('role-configuration-content expanded');
    clicks.get("role")!();
    expect(app.innerHTML).toContain('<h2>『梅林』</h2>');
    expect(app.innerHTML).toContain('『梅林』会看到所有藏锋者玩家的身份（『莫德雷德』除外）');
    expect(app.innerHTML).toContain('portrait detail-art');
    expect(app.innerHTML).not.toContain('role-configuration-content expanded');
    clicks.get("close")!();
    expect(app.innerHTML).not.toContain('role-detail-card');
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it("keeps task numbers and readable pending, active, success and failure states", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "vote", questIndex: 0, history: [
      { type: "mission", quest: 2, team: ["p3"], result: "success", fails: 0 },
      { type: "mission", quest: 4, team: ["p4"], result: "fail", fails: 1 },
    ] });
    for (let quest = 1; quest <= 5; quest++) expect(app.innerHTML).toContain(`<span class="quest-index">任务 ${quest}</span>`);
    expect(app.innerHTML).toContain('aria-label="任务1，2人，表决中"');
    expect(app.innerHTML).toContain('aria-label="任务2，2人，成功，查看详情"');
    expect(app.innerHTML).toContain('aria-label="任务3，3人，待选"');
    expect(app.innerHTML).toContain('aria-label="任务4，3人，失败，查看详情"');
    expect(app.innerHTML).toContain('quest-marker success');
    expect(app.innerHTML).toContain('quest-marker fail');
    expect(app.innerHTML).not.toContain('<div class="quest-status">✓');
  });

  it("shows rejection presentation until the server announces next-leader selection, without replaying on heartbeat", async () => {
    await import("./main");
    const state = { ...roomState(), phase: "proposalResult" as const, rejectCount: 1, history: [{ type: "vote" as const, quest: 1, team: ["p3", identity.playerId], approvals: 2, rejections: 3 }], timer: { kind: "proposalResult" as const, label: "发车结果", deadline: Date.now() + 5_000, durationMs: 5_000 } };
    handlers.get("room:state")!(state);
    handlers.get("player:privateState")!(privatePlayer({ canVote: true }));
    expect(app.innerHTML).toContain('proposal-outcome');
    expect(app.innerHTML).toContain('<h2>发车失败</h2>');
    expect(app.innerHTML).toContain('public-portrait');
    expect(app.innerHTML).toContain('5 秒');
    expect(app.innerHTML).not.toContain('data-action="vote-yes"');
    expect(app.innerHTML).not.toContain('data-action="end-speech"');
    const html = app.innerHTML;
    handlers.get("room:state")!(structuredClone(state));
    expect(app.innerHTML).toBe(html);
    handlers.get("room:state")!({ ...state, phase: "team", leaderId: identity.playerId, speechOrder: [], timer: { kind: "team", label: "队长组队", deadline: Date.now() + 30_000, durationMs: 30_000 } });
    expect(app.innerHTML).not.toContain('proposal-outcome');
    expect(app.innerHTML).not.toContain('aria-label="发言顺序"');
  });

  it.each(["vote", "mission"] as const)("renders the server 30-second timer for %s", async phase => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase, timer: { kind: phase, label: "投票", deadline: Date.now() + 30_000, durationMs: 30_000 } });
    expect(app.innerHTML).toContain('class="game-timer-time">0:30');
    expect(app.innerHTML).toContain('data-timer-duration="30000"');
  });

  it("shows identity animation for the server reveal deadline and never replays it on heartbeat", async () => {
    await import("./main");
    const state = { ...roomState(), phase: "reveal" as const, timer: { kind: "reveal" as const, label: "身份揭晓", deadline: Date.now() + 10_000, durationMs: 10_000 } };
    handlers.get("room:state")!(state);
    handlers.get("player:privateState")!(privatePlayer());
    const append = document.body.appendChild as ReturnType<typeof vi.fn>;
    const overlay = append.mock.calls[0][0] as ReturnType<typeof createElement>;
    expect(overlay.className).toBe("role-reveal-overlay");
    expect(overlay.innerHTML).toContain("10 秒");
    expect(overlay.innerHTML).toContain("identity-seal");
    expect(overlay.innerHTML).toContain('class="role-name-reveal">『亚瑟忠臣』</h2>');
    expect(overlay.innerHTML).not.toContain("modal-close");
    handlers.get("room:state")!(structuredClone(state));
    handlers.get("player:privateState")!(privatePlayer());
    expect(append).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(9_999);
    expect(overlay.remove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(overlay.remove).toHaveBeenCalledTimes(1);
  });

  it("shows anonymous mission cards and the result pause instead of the next team controls", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "missionResult", history: [
      { type: "mission", quest: 2, team: ["p-host", identity.playerId], result: "fail", fails: 1 },
    ], score: { success: 0, fail: 1 }, timer: { kind: "missionResult", label: "任务结果", deadline: Date.now() + 8_000, durationMs: 8_000 } });
    expect(app.innerHTML).toContain("mission-outcome outcome-fail");
    expect(app.innerHTML).toContain("1 张成功牌");
    expect(app.innerHTML).toContain("1 张失败牌");
    expect(app.innerHTML).not.toContain('data-action="propose"');
    expect(app.innerHTML).not.toContain('data-action="mission-fail"');
    const cards = app.innerHTML.split('aria-label="任务牌汇总">')[1].split('</div></div>')[0];
    expect(cards).not.toContain("p-self");
    expect(cards).not.toContain("p-host");
  });

  it("keeps task and member choices local and preserves them across changed server snapshots", async () => {
    const callbacks = new Map<string, () => void>();
    const players = roomState().players.slice(0, 3).map(p => ({ dataset: { playerId: p.id }, addEventListener: (_: string, cb: () => void) => callbacks.set(p.id, cb) }));
    const quest = { dataset: { questIndex: "2" }, addEventListener: (_: string, cb: () => void) => callbacks.set("quest", cb) };
    app.querySelectorAll.mockImplementation((...args: unknown[]) => args[0] === ".player-card" ? players as never[] : args[0] === "[data-quest-index]" ? [quest] as never[] : []);
    app.querySelector.mockImplementation(selector => selector === "[data-action='propose']" ? {
      addEventListener: (_: string, cb: () => void) => callbacks.set("submit", cb),
    } : null);
    await import("./main");
    const state = { ...roomState(), phase: "team" as const, leaderId: identity.playerId, teamSize: 2 };
    handlers.get("room:state")!(state);
    handlers.get("player:privateState")!(privatePlayer({ canPropose: true }));
    callbacks.get("quest")!();
    players.forEach(p => callbacks.get(p.dataset.playerId)!());
    expect(app.innerHTML).toContain("3 / 3");
    expect(socket.emit).not.toHaveBeenCalled();
    handlers.get("room:state")!({ ...state, players: state.players.map(p => p.id === "p5" ? { ...p, connected: false } : p) });
    expect(app.innerHTML).toContain("3 / 3");
    callbacks.get("submit")!();
    expect(socket.emit.mock.calls[0][0]).toBe("team:propose");
    expect(socket.emit.mock.calls[0][1]).toMatchObject({ questIndex: 2, team: players.map(p => p.dataset.playerId) });
  });

  it("never uses private role artwork for public player seats", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "team" });
    handlers.get("player:privateState")!(privatePlayer({ role: "merlin", roleName: "梅林" }));
    const table = app.innerHTML.split('aria-label="圆桌座位">')[1].split('<aside')[0];
    expect(table.match(/public-portrait/g)).toHaveLength(5);
    expect(table).not.toContain("portrait-guest");
    expect(table).not.toContain("梅林");
  });
  it("shows forced launch controls and history without fabricated rejection votes", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "team", leaderId: identity.playerId, rejectCount: 4 });
    handlers.get("player:privateState")!(privatePlayer({ canPropose: true }));
    expect(app.innerHTML).toContain("本次队伍提交后强制发车");
    expect(app.innerHTML).toContain("确认发车");
    handlers.get("room:state")!({ ...roomState(), phase: "mission", proposal: [identity.playerId], history: [
      { type: "vote", quest: 1, team: [identity.playerId], result: "success", forced: true, approvals: 0, rejections: 0 },
    ] });
    handlers.get("player:privateState")!(privatePlayer({ canMission: true }));
    expect(app.innerHTML).toContain("第 5 次提案，免表决");
    expect(app.innerHTML).not.toContain("history-vote-bar");
    expect(app.innerHTML).not.toContain('data-action="vote-no"');
  });

  it("allows a good player to approve or reject a team, but disables mission failure", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "vote", leaderId: "p-host", proposal: [identity.playerId] });
    handlers.get("player:privateState")!(privatePlayer({ canVote: true }));
    expect(app.innerHTML).toContain('data-action="vote-no"');
    expect(app.innerHTML).not.toMatch(/data-action="vote-no" disabled/);

    handlers.get("room:state")!({ ...roomState(), phase: "mission", proposal: [identity.playerId] });
    handlers.get("player:privateState")!(privatePlayer({ canMission: true }));
    expect(app.innerHTML).toMatch(/data-action="mission-fail" disabled/);
    expect(app.innerHTML).not.toMatch(/data-action="mission-success" disabled/);
  });

  it("never gives the proposal leader a vote button", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "vote", leaderId: identity.playerId });
    handlers.get("player:privateState")!(privatePlayer());
    expect(app.innerHTML).toContain("等待表决");
    expect(app.innerHTML).not.toContain('data-action="vote-yes"');
    expect(app.innerHTML).not.toContain('data-action="vote-no"');
  });

  it("hides private identity on request and keeps it hidden after public updates", async () => {
    let hide: (() => void) | undefined;
    app.querySelector.mockImplementation(selector => selector === "[data-action='toggle-private']" ? {
      addEventListener: (_event: string, callback: () => void) => { hide = callback; },
    } : null);
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "team" });
    handlers.get("player:privateState")!(privatePlayer());
    expect(app.innerHTML).toContain("私密信息测试");
    hide!();
    expect(app.innerHTML).not.toContain("私密信息测试");
    expect(app.innerHTML).not.toContain('class="role-name">『亚瑟忠臣』');
    expect(app.innerHTML).toContain('aria-label="本局身份"');
    handlers.get("room:state")!({ ...roomState(), phase: "vote" });
    expect(app.innerHTML).toContain("身份已隐藏");
  });

  it("does not rewrite the page on an unchanged heartbeat", async () => {
    await import("./main");
    const state = roomState();
    handlers.get("room:state")!(state);
    let html = app.innerHTML;
    const setter = vi.fn((value: string) => { html = value; });
    Object.defineProperty(app, "innerHTML", { get: () => html, set: setter, configurable: true });
    handlers.get("room:state")!(structuredClone(state));
    expect(setter).not.toHaveBeenCalled();
  });

  it("requires confirmation before sending room:leave and waits for the ack", async () => {
    const callbacks = new Map<string, () => void>();
    app.querySelector.mockImplementation(selector => ["[data-action='leave']", "[data-action='leave-confirm']"].includes(selector) ? {
      addEventListener: (_event: string, callback: () => void) => callbacks.set(selector, callback),
    } : null);
    await import("./main");
    handlers.get("room:state")!(roomState());
    callbacks.get("[data-action='leave']")!();
    expect(app.innerHTML).toContain("离开房间？");
    expect(socket.emit).not.toHaveBeenCalled();
    callbacks.get("[data-action='leave-confirm']")!();
    expect(socket.emit.mock.calls[0][0]).toBe("room:leave");
    expect(storage.has(sessionKey)).toBe(true);
    socket.emit.mock.calls[0][2]({ ok: true });
    expect(storage.has(sessionKey)).toBe(false);
    expect(app.innerHTML).toContain("landing-container");
  });

  it("keeps entered names when switching between entry modes", async () => {
    let input: ((event: unknown) => void) | undefined;
    let switchMode: (() => void) | undefined;
    const nameInput = { value: "阿辰<script>", addEventListener: (_: string, cb: typeof input) => { input = cb; } };
    const tab = { dataset: { entryMode: "join" }, addEventListener: (_: string, cb: () => void) => { switchMode = cb; } };
    app.querySelectorAll.mockImplementation((...args: unknown[]) => {
      if (args[0] === "#nameInput, #joinNameInput") return [nameInput] as never[];
      if (args[0] === "[data-entry-mode]") return [tab] as never[];
      return [];
    });
    await import("./main");
    input!({ target: nameInput });
    switchMode!();
    expect(app.innerHTML).toContain('value="阿辰&lt;script&gt;"');
    expect(app.innerHTML).toContain('class="landing-card card-create" hidden');
  });

  it("shows revealed role portraits only from the final public result", async () => {
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "result", winner: "good", winnerReason: "刺客未命中梅林", revealedRoles: [
      { playerId: identity.playerId, role: "merlin", roleName: "梅林", side: "good" },
    ] });
    expect(app.innerHTML).toContain("result-roster");
    expect(app.innerHTML).toContain('<span>『梅林』</span>');
    expect(app.innerHTML).toContain('『刺客』未命中『梅林』');
    expect(app.innerHTML).not.toContain('data-action="restart"');
  });

  it("keeps assassination selection local until the player confirms", async () => {
    let chooseTarget: (() => void) | undefined;
    let confirmTarget: (() => void) | undefined;
    const card = { dataset: { playerId: "p-host" }, addEventListener: (_: string, callback: () => void) => { chooseTarget = callback; } };
    app.querySelectorAll.mockImplementation((...args: unknown[]) => args[0] === ".player-card" ? [card] as never[] : []);
    app.querySelector.mockImplementation(selector => selector === "[data-action='assassinate']" ? {
      addEventListener: (_: string, callback: () => void) => { confirmTarget = callback; },
      classList: { add: vi.fn(), remove: vi.fn() },
    } : null);
    await import("./main");
    handlers.get("room:state")!({ ...roomState(), phase: "assassin" });
    handlers.get("player:privateState")!(privatePlayer({ role: "assassin", roleName: "刺客", side: "evil", canAssassinate: true }));
    expect(app.innerHTML).toContain('选择你认为是『梅林』的玩家');
    chooseTarget!();
    expect(app.innerHTML).toContain("已选 Host");
    expect(socket.emit).not.toHaveBeenCalled();
    confirmTarget!();
    expect(socket.emit.mock.calls[0][0]).toBe("assassin:choose");
    expect(socket.emit.mock.calls[0][1]).toMatchObject({ targetId: "p-host", roomCode: identity.roomCode });
  });
});

describe("Solo player count selection", () => {
  it.each([5, 6, 7, 8, 9, 10])("creates a %i-player room only after confirmation and adds count-minus-one AI", async count => {
    storage.clear();
    const clicks = new Map<string, () => void>();
    let change: ((event: { target: { value: string } }) => void) | undefined;
    app.querySelector.mockImplementation(selector => {
      if (selector === "#soloPlayerCount") return { addEventListener: (_: string, callback: typeof change) => { change = callback; } };
      if (["[data-action='solo']", "[data-action='solo-start']"].includes(selector)) return { addEventListener: (_: string, callback: () => void) => clicks.set(selector, callback) };
      return null;
    });
    await import("./main");
    clicks.get("[data-action='solo']")!();
    expect(app.innerHTML).toContain('<h2>单机对局</h2>');
    expect(socket.emit).not.toHaveBeenCalled();
    change!({ target: { value: String(count) } });
    expect(app.innerHTML).toContain(`<option value="${count}" selected>`);
    expect(app.innerHTML).toContain(`1 / ${count - 1}`);
    clicks.get("[data-action='solo-start']")!();
    clicks.get("[data-action='solo-start']")!();
    const creation = socket.emit.mock.calls.find(([event]) => event === "room:create")!;
    expect(socket.emit.mock.calls.filter(([event]) => event === "room:create")).toHaveLength(1);
    expect(creation[1]).toMatchObject({ name: "测试玩家", targetPlayerCount: count, requestId: expect.stringMatching(/^r_[a-f0-9]{32}$/), issuedAt: expect.any(Number) });
    const auth = { roomCode: "SOLO1", playerId: "solo-host", sessionToken: "solo-session" };
    creation[2]({ ok: true, ...auth });
    vi.advanceTimersByTime(520);
    expect(JSON.parse(storage.get(sessionKey)!)).toMatchObject(auth);
    const bots = socket.emit.mock.calls.find(([event]) => event === "room:addAI")!;
    expect(bots[1]).toMatchObject({ ...auth, count: count - 1, requestId: expect.any(String) });
    bots[2]({ ok: true });
    expect(socket.emit.mock.calls.find(([event]) => event === "room:start")?.[1]).toMatchObject({ ...auth, requestId: expect.any(String) });
  });
});

describe("Gallery faction grouping", () => {
  it("keeps all good cards including the female servant ahead of a separate evil group", async () => {
    let open: (() => void) | undefined;
    app.querySelector.mockImplementation(selector => selector === "[data-action='show-gallery']" ? {
      addEventListener: (_: string, callback: () => void) => { open = callback; },
    } : null);
    await import("./main");
    open!();
    const good = app.innerHTML.split('class="gallery-group" aria-label="守誓者角色">')[1].split('class="gallery-group" aria-label="藏锋者角色">')[0];
    const evil = app.innerHTML.split('class="gallery-group" aria-label="藏锋者角色">')[1];
    expect(good.match(/class="role-card-gallery good"/g)).toHaveLength(4);
    expect(good).toContain('<h3>『亚瑟的忠臣（女性）』</h3>');
    expect(good).toContain('data-role="亚瑟的忠臣（女性）"');
    expect(good).toContain('『Loyal Servant of Arthur』');
    expect(good).not.toContain('class="role-card-gallery evil"');
    expect(evil.match(/class="role-card-gallery evil"/g)).toHaveLength(5);
    expect(evil).toContain('<h3>『莫德雷德的爪牙』</h3>');
    expect(evil).not.toContain("忠臣");
  });

  it.each(["good", "evil"])("keeps the %s filter restricted to its matching group", async side => {
    let open: (() => void) | undefined;
    let filter: (() => void) | undefined;
    app.querySelector.mockImplementation(selector => selector === "[data-action='show-gallery']" ? {
      addEventListener: (_: string, callback: () => void) => { open = callback; },
    } : null);
    const button = { dataset: { gallerySide: side }, addEventListener: (_: string, cb: () => void) => { filter = cb; } };
    app.querySelectorAll.mockImplementation((...args: unknown[]) => args[0] === "[data-gallery-side]" ? [button] as never[] : []);
    await import("./main");
    open!();
    filter!();
    expect(app.innerHTML).toContain(`aria-label="${side === "good" ? "守誓者" : "藏锋者"}角色"`);
    expect(app.innerHTML).not.toContain(`class="role-card-gallery ${side === "good" ? "evil" : "good"}"`);
  });
});
