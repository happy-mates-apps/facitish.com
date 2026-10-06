import { getEndpoint } from "./config.js";

const input = document.getElementById("endpoint");
input.value = await getEndpoint();

document.getElementById("save").addEventListener("click", async () => {
  try {
    const url = new URL(input.value);
    await chrome.storage.sync.set({ endpoint: url.origin });
    document.getElementById("status").textContent = "Gemt. Luk og åbn sidepanelet igen.";
  } catch {
    document.getElementById("status").textContent = "Ugyldig adresse";
  }
});
