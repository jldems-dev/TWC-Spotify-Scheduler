const form = document.getElementById("server-form");
const address = document.getElementById("server");
const statusText = document.getElementById("status");
const button = form.querySelector("button");
const code = document.getElementById("access-code");
const pairing = document.getElementById("pairing");
const forget = document.getElementById("forget");
let saved = { address: "", paired: false };

function showState(state) {
  if (!state.error) saved = state;
  statusText.dataset.error = String(!!state.error);
  statusText.textContent = state.error || state.state;
  updateFields();
}

function updateFields() {
  pairing.hidden = saved.paired && address.value.trim() === saved.address;
  code.required = !pairing.hidden;
  forget.hidden = !saved.address;
}

address.addEventListener("input", updateFields);
window.connection.onStatus(showState);
void window.connection.status().then(state => {
  if (!address.value) address.value = state.address;
  showState(state);
}).catch(() => showState({ error: "Could not read the saved address." }));

form.addEventListener("submit", async event => {
  event.preventDefault();
  button.disabled = true;
  try {
    const state = await window.connection.connect(address.value, pairing.hidden ? "" : code.value.trim());
    code.value = "";
    if (state.address) address.value = state.address;
    showState(state);
  } catch {
    showState({ error: "Could not configure the connection." });
  } finally {
    button.disabled = false;
  }
});

forget.addEventListener("click", async () => {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const state = await window.connection.forget();
    if (!state.error) {
      address.value = "";
      code.value = "";
    }
    showState(state);
  } catch {
    showState({ error: "Could not forget the server." });
  } finally {
    button.disabled = false;
  }
});

const updatePanel = document.getElementById("client-update");
const updateStatus = document.getElementById("update-status");
const updateProgress = document.getElementById("update-progress");
const updateButton = document.getElementById("update-action");
const updateLater = document.getElementById("update-later");
const updateActions = {
  available: ["Download update", "download"],
  ready: ["Install and restart", "install"],
  error: ["Retry update check", "check"],
  "available-later": ["Show update", "resume"],
  "ready-later": ["Show update", "resume"],
};
function renderUpdate(update) {
  updatePanel.hidden = update.phase === "idle" || update.phase === "current";
  updateStatus.textContent = update.availableVersion ? `${update.message} ? v${update.availableVersion}` : update.message;
  updateProgress.hidden = update.phase !== "downloading";
  updateProgress.value = update.progress ?? 0;
  updateProgress.setAttribute("aria-label", "Update download progress");
  const action = updateActions[update.phase];
  updateButton.hidden = !action;
  updateButton.textContent = action?.[0] ?? "";
  updateButton.dataset.action = action?.[1] ?? "";
  updateLater.hidden = update.phase !== "available" && update.phase !== "ready";
}
window.connection.onUpdate(renderUpdate);
void window.connection.updateStatus().then(renderUpdate).catch(() => {});
function requestUpdateAction(action) {
  void window.connection.updateAction(action).catch(() => {
    updateStatus.textContent = "Could not complete the update action. Try again.";
  });
}
updateButton.addEventListener("click", () => requestUpdateAction(updateButton.dataset.action));
updateLater.addEventListener("click", () => requestUpdateAction("postpone"));
