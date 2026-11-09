import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { NS } from "./rules.mjs?v=0.11.5";
import { createPanel, scenePortraits } from "./panel-ui.mjs?v=0.11.5";
import { createSnapshotGate, isOlderSnapshot } from "./snapshot-sync.mjs?v=0.11.5";

if (new URLSearchParams(location.search).has("obrref")) {
  OBR.onReady(async () => {
    try {
      const [role, connection, name, metadata] = await Promise.all([
        OBR.player.getRole(), OBR.player.getConnectionId(), OBR.player.getName(), OBR.room.getMetadata(),
      ]);
      const panel = createPanel({ connection, name, host: role === "GM",
        send: data => OBR.broadcast.sendMessage(NS + "/command", data, { destination: "ALL" }),
      });
      const key = NS + "/state";
      let current = metadata[key];
      const gate = await createSnapshotGate(OBR, connection, role, () => current);
      const update = next => { if (!isOlderSnapshot(next, current)) { current = next; panel.update(next); } };
      panel.disconnected("Ведущий должен открыть сцену «Осколок Силы».");
      OBR.room.onMetadataChange(next => update(next[key]));
      OBR.broadcast.onMessage(NS + "/command", ({ connectionId, data }) => {
        if (data?.type === "snapshot") void gate.accept(connectionId, data.snapshot).then(accepted => { if (accepted) update(data.snapshot); }).catch(console.error);
      });
      update(current);
      // Opening a panel can overlap a phase change while the party roster loads.
      // Subscribe first, then close that gap with a guarded persistent read.
      update((await OBR.room.getMetadata())[key]);
      const loadPortraits = async ready => panel.portraits(ready ? scenePortraits(await OBR.scene.items.getItems()) : {});
      OBR.scene.onReadyChange(ready => void loadPortraits(ready).catch(console.error));
      OBR.scene.items.onChange(items => panel.portraits(scenePortraits(items)));
      await loadPortraits(await OBR.scene.isReady());
    } catch (error) {
      console.error("Dominion panel", error);
      document.getElementById("loading-help").textContent = "Не удалось подключиться. Обнови страницу Owlbear.";
    }
  });
} else {
  document.getElementById("loading-help").textContent = "Открой «Доминион» по значку бегуна в комнате Owlbear.";
}
