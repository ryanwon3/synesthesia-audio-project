import type { CompanionClient, CompanionStatus } from "./CompanionClient";
import { isPairingCode } from "./CompanionProtocol";

const statusText: Record<CompanionStatus, string> = {
  unpaired: "Not connected",
  pairing: "Connecting…",
  paired: "Connected to the Windows companion",
  unavailable: "Windows companion unavailable",
};

const recoveryText =
  "Open the Windows app and copy a new code; use the built-in offline visualizer if access is denied.";

// Explicit pairing dialog. The code lives only in the input until submit or
// close; messages are generic and never echo it.
export class CompanionPanel {
  private readonly codeInput: HTMLInputElement;
  private readonly statusElement: HTMLElement;
  private readonly messageElement: HTMLElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly disconnectButton: HTMLButtonElement;
  private status: CompanionStatus = "unpaired";
  private attempt = 0;

  public constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly client: CompanionClient,
  ) {
    this.codeInput = part(dialog, "[data-companion-code]");
    this.statusElement = part(dialog, "[data-companion-status]");
    this.messageElement = part(dialog, "[data-companion-message]");
    this.submitButton = part(dialog, "[data-companion-submit]");
    this.disconnectButton = part(dialog, "[data-companion-disconnect]");
    part<HTMLFormElement>(dialog, "form").addEventListener("submit", (event) => this.handleSubmit(event));
    this.disconnectButton.addEventListener("click", () => this.handleDisconnect());
    part<HTMLElement>(dialog, "[data-close-dialog]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      this.codeInput.value = "";
    });
  }

  public open(): void {
    this.messageElement.textContent = "";
    this.render();
    if (!this.dialog.open) {
      this.dialog.showModal();
    }

    window.queueMicrotask(() => this.codeInput.focus());
  }

  public setStatus(status: CompanionStatus): void {
    this.status = status;
    this.render();
  }

  private handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const code = this.codeInput.value.trim();
    this.codeInput.value = "";
    // A new family requires an explicit disconnect; a duplicate submit must not cancel an in-flight pair.
    if (this.status === "paired" || this.status === "pairing") {
      return;
    }

    if (!isPairingCode(code)) {
      this.messageElement.textContent = "Enter the 22-character code from the Windows app.";
      return;
    }

    const attempt = ++this.attempt;
    this.messageElement.textContent = "";
    this.client.pair(code).then(
      () => {
        if (attempt === this.attempt) {
          this.dialog.close();
        }
      },
      () => {
        if (attempt === this.attempt && isPairingCode(code)) {
          this.messageElement.textContent = `Couldn't connect. ${recoveryText}`;
        }
      },
    );
  }

  private handleDisconnect(): void {
    this.attempt += 1;
    this.client.disconnect();
    this.messageElement.textContent = "Disconnected. Open the Windows app and copy a new code to reconnect.";
  }

  private render(): void {
    this.statusElement.textContent = statusText[this.status];
    this.dialog.dataset.state = this.status;
    this.submitButton.disabled = this.status === "pairing" || this.status === "paired";
    this.disconnectButton.disabled = this.status !== "paired";
  }
}

function part<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing companion dialog element ${selector}.`);
  }

  return element;
}
