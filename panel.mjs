import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
import { NS } from "./rules.mjs?v=0.4.0";
import { createPanel, scenePortraits } from "./panel-ui.mjs?v=0.6.0";

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
      panel.disconnected("Ведущий должен открыть сцену «Осколок Силы».");
      OBR.room.onMetadataChange(next => panel.update(next[key]));
      panel.update(metadata[key]);
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
