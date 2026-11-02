import { describe, expect, it } from "vitest";
import { NetworkStateStore } from "./networkState";
import { selectGameViewContext } from "./selectors";
import { ServerStateStore } from "./serverState";
import { UiStateStore } from "./uiState";

describe("client state selectors", () => {
  it("combines authoritative, UI, and network state without giving views a socket", () => {
    const server = new ServerStateStore({ roomCode: "ABCDE", playerId: "p_1", sessionToken: "s", name: "玩家" });
    const ui = new UiStateStore("create", { name: "玩家", roomCode: "", count: "5" });
    const network = new NetworkStateStore(true);
    ui.pendingTeam.add("p_2");
    network.pendingActions.add("team:propose");
    const context = selectGameViewContext(server, ui, network);
    expect(context.identity?.playerId).toBe("p_1");
    expect([...context.pendingTeam]).toEqual(["p_2"]);
    expect([...context.pendingActions]).toEqual(["team:propose"]);
    expect(context).not.toHaveProperty("socket");
  });
});
