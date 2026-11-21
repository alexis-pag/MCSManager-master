import axios from "axios";
import { onBeforeUnmount, ref } from "vue";
import { describeAiError } from "@/hooks/useInstanceAiChat";
import { useAppStateStore } from "@/stores/useAppStateStore";

export type AiBanState =
  | "reviewing"
  | "justified"
  | "not_justified"
  | "insufficient_evidence"
  | "applied"
  | "failed";

export interface AiBanCase {
  uuid: string;
  requesterName: string;
  player: string;
  reason: string;
  description: string;
  logLines: string[];
  images: { id: string; mime: string; size: number }[];
  state: AiBanState;
  verdict: string;
  sanction: string;
  explanation: string;
  createdAt: string;
  decidedAt: string;
  appliedAt: string;
  appliedByName: string;
  overrideNote: string;
}

export interface BanRequestForm {
  player: string;
  reason: string;
  description: string;
  logLines: string[];
  images: string[];
}

export const BAN_REASON_MIN = 15;
export const BAN_DESCRIPTION_MIN = 30;
export const BAN_MAX_IMAGES = 3;
export const BAN_MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const BAN_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const POLL_MS = 3000;

/** Client-side check mirroring the panel rules (the panel validates again). */
export function banFormProblem(form: BanRequestForm): "" | "player" | "reason" | "evidence" {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(form.player.trim())) return "player";
  const reason = form.reason.trim();
  if (reason.length < BAN_REASON_MIN || reason.length > 200) return "reason";
  if (
    !form.logLines.length &&
    form.description.trim().length < BAN_DESCRIPTION_MIN &&
    !form.images.length
  ) {
    return "evidence";
  }
  return "";
}

/** AI-moderated ban requests of one instance. */
export function useAiBan(daemonId: string, instanceUuid: string) {
  const { state } = useAppStateStore();
  const cases = ref<AiBanCase[]>([]);
  const current = ref<AiBanCase | null>(null);
  const logLines = ref<string[]>([]);
  const busy = ref(false);
  const error = ref("");
  let timer: number | undefined;

  const config = (extra: Record<string, unknown> = {}) => ({
    params: { token: state.userInfo?.token, daemonId, uuid: instanceUuid, ...extra },
    headers: { "X-Requested-With": "XMLHttpRequest" }
  });
  const run = async <T>(task: () => Promise<T>): Promise<T | undefined> => {
    busy.value = true;
    error.value = "";
    try {
      return await task();
    } catch (err) {
      error.value = describeAiError(err);
      return undefined;
    } finally {
      busy.value = false;
    }
  };

  const loadCases = () =>
    run(async () => {
      const result = await axios.get("./api/ai/bans", config());
      cases.value = result.data?.data || [];
    });

  const findLogLines = (player: string) =>
    run(async () => {
      const result = await axios.get("./api/ai/bans/log-lines", config({ player }));
      logLines.value = result.data?.data || [];
      return logLines.value;
    });

  const stopPolling = () => {
    if (timer) window.clearInterval(timer);
    timer = undefined;
  };

  const refreshCurrent = async () => {
    if (!current.value) return stopPolling();
    try {
      const result = await axios.get(
        `./api/ai/bans/case/${encodeURIComponent(current.value.uuid)}`,
        config()
      );
      current.value = result.data?.data || current.value;
      if (current.value?.state !== "reviewing") {
        stopPolling();
        await loadCases();
      }
    } catch (err) {
      stopPolling();
      error.value = describeAiError(err);
    }
  };

  const watchCase = (banCase: AiBanCase) => {
    current.value = banCase;
    stopPolling();
    if (banCase.state === "reviewing") {
      timer = window.setInterval(() => void refreshCurrent(), POLL_MS);
    }
  };

  const submit = (form: BanRequestForm) =>
    run(async () => {
      const result = await axios.post(
        "./api/ai/bans",
        {
          player: form.player.trim(),
          reason: form.reason.trim(),
          description: form.description.trim(),
          logLines: form.logLines,
          images: form.images
        },
        config()
      );
      const banCase: AiBanCase | undefined = result.data?.data;
      if (banCase) watchCase(banCase);
      return banCase;
    });

  const apply = (overrideNote?: string) =>
    run(async () => {
      if (!current.value) return;
      const result = await axios.post(
        `./api/ai/bans/case/${encodeURIComponent(current.value.uuid)}/apply`,
        overrideNote ? { overrideNote } : {},
        config()
      );
      current.value = result.data?.data || current.value;
      await loadCases();
      return current.value;
    });

  /** Evidence images need the API headers, so they are fetched as blobs. */
  const evidenceUrl = async (banCase: AiBanCase, imageId: string) => {
    const result = await axios.get(
      `./api/ai/bans/case/${encodeURIComponent(banCase.uuid)}/evidence/${encodeURIComponent(
        imageId
      )}`,
      { ...config(), responseType: "blob" }
    );
    return URL.createObjectURL(result.data as Blob);
  };

  onBeforeUnmount(stopPolling);

  return {
    cases,
    current,
    logLines,
    busy,
    error,
    loadCases,
    findLogLines,
    submit,
    apply,
    watchCase,
    evidenceUrl,
    stopPolling
  };
}
