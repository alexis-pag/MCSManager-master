import { describe, expect, it } from "vitest";
import {
  isCommandRefusal,
  isLocalHostname,
  isRecoverableCreationConfirmation,
  LocalAiConfigurationError,
  validateEngineUrl
} from "../local_ai_service";

describe("Stale command refusals", () => {
  it("detects earlier answers claiming commands cannot be run", () => {
    expect(
      isCommandRefusal(
        "Je suis désolé, mais je ne peux pas exécuter de commandes shell depuis MCSManager."
      )
    ).toBe(true);
    expect(isCommandRefusal("Je ne peux pas exécuter directement un fichier JAR.")).toBe(true);
    expect(isCommandRefusal("I can't run shell commands from MCSManager.")).toBe(true);
    expect(isCommandRefusal("Forge est installé. Démarre le serveur avec run.bat.")).toBe(false);
    expect(isCommandRefusal("Je ne peux pas trouver ce fichier.")).toBe(false);
  });
});

describe("Local AI engine address validation", () => {
  it("accepts loopback and private network hosts", () => {
    expect(isLocalHostname("localhost")).toBe(true);
    expect(isLocalHostname("127.0.0.1")).toBe(true);
    expect(isLocalHostname("10.0.0.8")).toBe(true);
    expect(isLocalHostname("172.16.0.2")).toBe(true);
    expect(isLocalHostname("192.168.1.2")).toBe(true);
  });

  it("rejects public hosts", () => {
    expect(isLocalHostname("example.com")).toBe(false);
    expect(isLocalHostname("8.8.8.8")).toBe(false);
  });

  it("rejects non-private 172 addresses", () => {
    expect(isLocalHostname("172.15.0.1")).toBe(false);
    expect(isLocalHostname("172.32.0.1")).toBe(false);
  });

  it("accepts the LM Studio API base and rejects a model appended to it", () => {
    expect(validateEngineUrl("http://127.0.0.1:1234/v1")).toBe("http://127.0.0.1:1234/v1");
    expect(() => validateEngineUrl("http://127.0.0.1:1234/v1/openai/gpt-oss-20b")).toThrow(
      LocalAiConfigurationError
    );
  });
});

describe("Minecraft creation confirmation recovery", () => {
  it("recognizes yes after the assistant already asked to confirm a creation", () => {
    const messages = [
      {
        id: "user-1",
        role: "user" as const,
        content: "Crée un serveur Minecraft en version 26.3",
        createdAt: ""
      },
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "Veuillez confirmer pour lancer la création.",
        createdAt: ""
      }
    ];

    expect(isRecoverableCreationConfirmation(messages, "oui")).toBe(true);
    expect(isRecoverableCreationConfirmation(messages, "non")).toBe(false);
  });

  it("does not treat an unrelated yes as consent to create a server", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "Je peux vous expliquer comment créer un serveur.",
        createdAt: ""
      }
    ];

    expect(isRecoverableCreationConfirmation(messages, "oui")).toBe(false);
  });
});
