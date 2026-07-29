"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Card, Button, Input, Modal, CardSkeleton } from "@/shared/components";
import Toggle from "@/shared/components/Toggle";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { isPublicDisplayBaseUrl, useDisplayBaseUrl } from "@/shared/hooks";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";
import { getProviderDisplayName } from "@/lib/display/names";
import { useTranslations } from "next-intl";
import VscodeTokenAliasCard from "./VscodeTokenAliasCard";

const BUILD_TIME_CLOUD_URL = process.env.NEXT_PUBLIC_CLOUD_URL || null;
const CLOUD_ACTION_TIMEOUT_MS = 15000;

type TranslationValues = Record<string, string | number | boolean | Date>;

type APIPageClientProps = {
  machineId: string;
};

type EndpointProviderSummary = {
  id: string;
  provider: {
    name: string;
    alias?: string;
  };
};

type EndpointModelSummary = {
  id: string;
  owned_by?: string;
  parent?: string;
  type?: string;
  custom?: boolean;
  root?: string;
};

type CopyHandler = (text: string, key?: string) => void | Promise<void>;

function runEndpointBackgroundTask(taskName: string, task: () => Promise<unknown>) {
  void task().catch((error) => {
    console.log("Error running endpoint background task:", taskName, error);
  });
}

export default function APIPageClient({ machineId }: Readonly<APIPageClientProps>) {
  const [resolvedMachineId, setResolvedMachineId] = useState(machineId || "");
  const t = useTranslations("endpoint");
  const tc = useTranslations("common");
  const [loading, setLoading] = useState(true);

  // Endpoints / models state
  const [allModels, setAllModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [expandedEndpoint, setExpandedEndpoint] = useState(null);

  // Cloud sync state
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [showCloudModal, setShowCloudModal] = useState(false);
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [cloudStatus, setCloudStatus] = useState(null);
  const [syncStep, setSyncStep] = useState(""); // "syncing" | "verifying" | "disabling" | "done" | ""
  const [modalSuccess, setModalSuccess] = useState(false); // show success state in modal before closing
  const [selectedProvider, setSelectedProvider] = useState(null); // for provider models popup
  const [cloudBaseUrl, setCloudBaseUrl] = useState(BUILD_TIME_CLOUD_URL); // dynamic cloud URL from API response
  const [cloudConfigured, setCloudConfigured] = useState(Boolean(BUILD_TIME_CLOUD_URL));
  const [searchProviders, setSearchProviders] = useState<any[]>([]);
  const [localApiUrl, setLocalApiUrl] = useState("http://localhost:20128/v1");
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [customSystemPromptEnabled, setCustomSystemPromptEnabled] = useState(false);
  const [customSystemPrompt, setCustomSystemPrompt] = useState("");

  const { copied, copy } = useCopyToClipboard();

  const translateOrFallback = useCallback(
    (key: string, fallback: string, values?: TranslationValues) => {
      try {
        const message = values ? t(key as never, values as never) : t(key as never);
        if (!message || message === key || message === `endpoint.${key}`) {
          return fallback;
        }
        return message;
      } catch {
        return fallback;
      }
    },
    [t]
  );

  const fetchSearchProviders = async () => {
    try {
      const res = await fetch("/api/search/providers");
      if (res.ok) {
        const data = await res.json();
        setSearchProviders(data.providers || []);
      }
    } catch {
      // Search endpoint may not be available
    }
  };

  useEffect(() => {
    let mounted = true;

    const loadPage = async () => {
      await loadCloudSettings(() => mounted);

      if (!mounted) return;
      setLoading(false);

      runEndpointBackgroundTask("models", fetchModels);
      runEndpointBackgroundTask("search-providers", fetchSearchProviders);
      runEndpointBackgroundTask("network-info", async () => {
        try {
          const res = await fetch("/api/network/info");
          if (res.ok) {
            const data = await res.json();
            if (mounted) {
              if (data.localUrl) setLocalApiUrl(data.localUrl);
              setLanUrls(data.lanUrls ?? []);
            }
          }
        } catch {
          // non-critical
        }
      });
    };

    void loadPage();

    return () => {
      mounted = false;
    };
  }, []);

  const fetchModels = async () => {
    setModelsLoading(true);
    try {
      const res = await fetch("/v1/models");
      if (res.ok) {
        const data = await res.json();
        setAllModels(data.data || []);
      }
    } catch (e) {
      console.log("Error fetching models:", e);
    } finally {
      setModelsLoading(false);
    }
  };

  // Categorize models by endpoint type
  // Filter out parent models (models with parent field set) to avoid showing duplicates
  const endpointData = useMemo(() => {
    const chat = allModels.filter((m) => !m.type && !m.parent);
    const embeddings = allModels.filter((m) => m.type === "embedding" && !m.parent);
    const images = allModels.filter((m) => m.type === "image" && !m.parent);
    const video = allModels.filter((m) => m.type === "video" && !m.parent);
    const rerank = allModels.filter((m) => m.type === "rerank" && !m.parent);
    const audioTranscription = allModels.filter(
      (m) => m.type === "audio" && m.subtype === "transcription" && !m.parent
    );
    const audioSpeech = allModels.filter(
      (m) => m.type === "audio" && m.subtype === "speech" && !m.parent
    );
    const moderation = allModels.filter((m) => m.type === "moderation" && !m.parent);
    const music = allModels.filter((m) => m.type === "music" && !m.parent);
    return {
      chat,
      embeddings,
      images,
      video,
      rerank,
      audioTranscription,
      audioSpeech,
      moderation,
      music,
    };
  }, [allModels]);

  const totalEndpointModelCount = useMemo(
    () => Object.values(endpointData).reduce((acc, models) => acc + models.length, 0),
    [endpointData]
  );

  const availableEndpointCount = useMemo(() => {
    const chatCount = endpointData.chat.length > 0 ? 4 : 0; // chat + responses + completions + messages
    const imageCount = endpointData.images.length > 0 ? 2 : 0; // image gen + image edits
    const otherMedia = [
      endpointData.embeddings,
      endpointData.audioTranscription,
      endpointData.audioSpeech,
      endpointData.music,
      endpointData.video,
    ].filter((m) => m.length > 0).length;
    const utilityFixed = 3; // batch + files + list models (always available)
    const modelUtility =
      (endpointData.rerank.length > 0 ? 1 : 0) + (endpointData.moderation.length > 0 ? 1 : 0);
    const searchCount = searchProviders.length > 0 ? 1 : 0;
    return chatCount + imageCount + otherMedia + utilityFixed + modelUtility + searchCount;
  }, [endpointData, searchProviders]);

  const postCloudAction = async (action, timeoutMs = CLOUD_ACTION_TIMEOUT_MS) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch("/api/sync/cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      if (error?.name === "AbortError") {
        return { ok: false, status: 408, data: { error: t("cloudRequestTimeout") } };
      }
      return { ok: false, status: 500, data: { error: error.message || t("cloudRequestFailed") } };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const loadCloudSettings = async (shouldApplyState: () => boolean = () => true) => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();

        if (!shouldApplyState()) {
          return;
        }

        setCloudEnabled(data.cloudEnabled || false);
        if (typeof data.cloudConfigured === "boolean") {
          setCloudConfigured(data.cloudConfigured);
        }
        if (data.cloudUrl) {
          setCloudBaseUrl(data.cloudUrl);
        }
        if (data.machineId) {
          setResolvedMachineId(data.machineId);
        }
        setCustomSystemPromptEnabled(!!data.customSystemPromptEnabled);
        setCustomSystemPrompt(data.customSystemPrompt || "");
      }
    } catch (error) {
      console.log("Error loading cloud settings:", error);
    }
  };

  const handleCustomSystemPromptEnabledChange = (value: boolean) => {
    setCustomSystemPromptEnabled(value);
    void fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customSystemPromptEnabled: value }),
    });
  };

  const handleCustomSystemPromptChange = (value: string) => {
    setCustomSystemPrompt(value);
    void fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customSystemPrompt: value }),
    });
  };

  const handleCloudToggle = (checked) => {
    if (checked) {
      if (!cloudConfigured) {
        setCloudStatus({
          type: "warning",
          message: "Cloud sync is not configured on this instance.",
        });
        return;
      }
      setShowCloudModal(true);
    } else {
      setShowDisableModal(true);
    }
  };

  // Auto-dismiss cloudStatus after 5s
  useEffect(() => {
    if (cloudStatus) {
      const timer = setTimeout(() => setCloudStatus(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [cloudStatus]);

  const dispatchCloudChange = () => {
    globalThis.dispatchEvent(new Event("cloud-status-changed"));
  };

  const handleEnableCloud = async () => {
    setCloudSyncing(true);
    setModalSuccess(false);
    setSyncStep("syncing");
    try {
      const { ok, status, data } = await postCloudAction("enable");
      if (ok) {
        setSyncStep("verifying");

        // Brief delay so user sees the verifying step
        await new Promise((r) => setTimeout(r, 600));

        // Sync succeeded — mark as enabled regardless of verify result
        setCloudEnabled(true);
        setSyncStep("done");
        setModalSuccess(true);
        setCloudSyncing(false);
        dispatchCloudChange();

        // Show success in modal for a moment, then close
        await new Promise((r) => setTimeout(r, 1200));
        setShowCloudModal(false);
        setModalSuccess(false);

        if (data.verified) {
          setCloudStatus({ type: "success", message: t("cloudConnectedVerified") });
        } else {
          setCloudStatus({
            type: "warning",
            message: data.verifyError
              ? t("connectedVerificationPendingWithError", { error: data.verifyError })
              : t("connectedVerificationPending"),
          });
        }

        // Update cloud URL from API response (fixes undefined/v1 when env var not set)
        if (data.cloudUrl) {
          setCloudBaseUrl(data.cloudUrl);
        }
        // Reload settings to ensure fresh state
        await loadCloudSettings();
      } else {
        // Sync failed — provide a helpful error message
        let errorMessage = data.error || t("failedEnable");
        if (status === 502 || status === 408) {
          errorMessage = t("cloudWorkerUnreachable");
        }
        setCloudStatus({ type: "error", message: errorMessage });
        setShowCloudModal(false);
      }
    } catch (error) {
      setCloudStatus({ type: "error", message: error.message || t("connectionFailed") });
      setShowCloudModal(false);
    } finally {
      setCloudSyncing(false);
      setSyncStep("");
    }
  };

  const handleConfirmDisable = async () => {
    setCloudSyncing(true);
    setSyncStep("syncing");

    try {
      // Step 1: Sync latest data from cloud
      await postCloudAction("sync");

      setSyncStep("disabling");

      // Step 2: Disable cloud
      const { ok, data } = await postCloudAction("disable");

      if (ok) {
        setCloudEnabled(false);
        setCloudStatus({ type: "success", message: t("cloudDisabledSuccess") });
        setShowDisableModal(false);
        dispatchCloudChange();
        await loadCloudSettings();
      } else {
        setCloudStatus({ type: "error", message: data.error || t("failedDisable") });
      }
    } catch (error) {
      console.log("Error disabling cloud:", error);
      setCloudStatus({ type: "error", message: t("failedDisable") });
    } finally {
      setCloudSyncing(false);
      setSyncStep("");
    }
  };

  const displayBaseUrl = useDisplayBaseUrl();
  const displayApiUrl = `${displayBaseUrl}/v1`;
  const publicDisplayApiUrl = isPublicDisplayBaseUrl(displayBaseUrl) ? displayApiUrl : null;
  const normalizedCloudBaseUrl = cloudBaseUrl
    ? resolvedMachineId && !cloudBaseUrl.endsWith(`/${resolvedMachineId}`)
      ? `${cloudBaseUrl}/${resolvedMachineId}`
      : cloudBaseUrl
    : null;
  const cloudEndpointNew = normalizedCloudBaseUrl ? `${normalizedCloudBaseUrl}/v1` : null;

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const currentEndpoint =
    (cloudEnabled && cloudEndpointNew ? cloudEndpointNew : null) ?? displayApiUrl;
  const activeUrls = [
    ...(publicDisplayApiUrl
      ? [{ label: t("tierPublic"), url: publicDisplayApiUrl, key: "active_public" }]
      : []),
    ...(cloudEnabled && cloudEndpointNew
      ? [{ label: t("activeCloud"), url: cloudEndpointNew, key: "active_cloud" }]
      : []),
    { label: t("activeLocal"), url: localApiUrl, key: "active_local" },
  ].filter(
    (candidate, index, candidates) =>
      candidates.findIndex((other) => other.url === candidate.url) === index
  );

  return (
    <div className="flex flex-col gap-8">
      {/* Endpoint Card */}
      <Card>
        <h2 className="text-lg font-semibold mb-4">{t("title")}</h2>

        {/* Cloud Status Toast */}
        {cloudStatus && (
          <div
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg mb-4 text-sm font-medium animate-in fade-in slide-in-from-top-2 duration-300 ${
              cloudStatus.type === "success"
                ? "bg-green-500/10 border border-green-500/30 text-green-400"
                : cloudStatus.type === "warning"
                  ? "bg-amber-500/10 border border-amber-500/30 text-amber-400"
                  : "bg-red-500/10 border border-red-500/30 text-red-400"
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">
              {cloudStatus.type === "success"
                ? "check_circle"
                : cloudStatus.type === "warning"
                  ? "warning"
                  : "error"}
            </span>
            <span className="flex-1">{cloudStatus.message}</span>
            <button
              onClick={() => setCloudStatus(null)}
              className="p-0.5 hover:bg-white/10 rounded transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">close</span>
            </button>
          </div>
        )}

        {/* Active URLs bar */}
        {activeUrls.length > 0 && (
          <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 p-3">
            <p className="text-[10px] font-semibold text-primary uppercase tracking-wider mb-2">
              {t("activeEndpoints")}
            </p>
            <div className="flex flex-col gap-1.5">
              {activeUrls.map(({ label, url, key }) => (
                <div key={key} className="flex items-center gap-2 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                  <span className="text-xs text-text-muted w-20 shrink-0">{label}</span>
                  <code className="text-xs font-mono text-text-main flex-1 truncate min-w-0">
                    {url}
                  </code>
                  <button
                    onClick={() => void copy(url, key)}
                    className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded border border-border/70 text-text-muted hover:text-text transition-colors"
                  >
                    <span className="material-symbols-outlined text-[12px]">
                      {copied === key ? "check" : "content_copy"}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Connection rows */}
        <div className="flex flex-col">
          {/* Local Server */}
          <div className="flex items-center gap-3 py-3">
            <span className="material-symbols-outlined text-[18px] text-emerald-500 shrink-0">
              computer
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-1 flex-wrap">
                <span className="text-sm font-medium">{t("localServer")}</span>
                {resolvedMachineId && (
                  <span className="text-xs text-text-muted">· {resolvedMachineId.slice(0, 8)}</span>
                )}
                {lanUrls.map((url) => (
                  <button
                    key={url}
                    onClick={() => void copy(url, `lan_${url}`)}
                    title={t("copyUrlTitle", { url })}
                    className="inline-flex items-center gap-0.5 text-[10px] text-text-muted hover:text-text transition-colors"
                  >
                    <code className="font-mono">{url.replace(/^https?:\/\//, "")}</code>
                    <span className="material-symbols-outlined text-[10px] opacity-60">
                      {copied === `lan_${url}` ? "check" : "content_copy"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/10 border border-green-500/30 text-green-400 shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              {t("statusRunning")}
            </span>
            <button
              onClick={() => void copy(localApiUrl, "endpoint_url")}
              className="shrink-0 flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-border/70 text-text-muted hover:text-text hover:border-border transition-colors"
            >
              <span className="material-symbols-outlined text-[14px]">
                {copied === "endpoint_url" ? "check" : "content_copy"}
              </span>
              {copied === "endpoint_url" ? tc("copied") : tc("copy")}
            </button>
          </div>

          {/* Cloud OmniRoute */}
          <div className="flex items-center gap-3 py-3">
            <span className="material-symbols-outlined text-[18px] text-blue-400 shrink-0">
              cloud
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium">{t("cloudOmniroute")}</span>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border shrink-0 ${
                cloudEnabled
                  ? "bg-green-500/10 border-green-500/30 text-green-400"
                  : "bg-surface border-border/70 text-text-muted"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${cloudEnabled ? "bg-green-400 animate-pulse" : "bg-text-muted"}`}
              />
              {cloudEnabled ? tc("active") : tc("disabled")}
            </span>
            {cloudEnabled ? (
              <Button
                size="sm"
                variant="secondary"
                icon="cloud_off"
                onClick={() => handleCloudToggle(false)}
                disabled={cloudSyncing}
                className="shrink-0 bg-red-500/10! text-red-500! hover:bg-red-500/20! border-red-500/30!"
              >
                {t("disableCloud")}
              </Button>
            ) : cloudConfigured ? (
              <Button
                size="sm"
                variant="primary"
                icon="cloud_upload"
                onClick={() => handleCloudToggle(true)}
                disabled={cloudSyncing}
                className="shrink-0"
              >
                {t("enableCloud")}
              </Button>
            ) : (
              <span className="text-xs text-text-muted shrink-0 px-2 py-1 rounded border border-border/70 bg-surface">
                {tc("notConfigured")}
              </span>
            )}
          </div>
        </div>

        {/* Custom System Prompt */}
        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-sm">{t("customSystemPromptTitle")}</p>
            <p className="text-sm text-text-muted">{t("customSystemPromptDescription")}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {customSystemPromptEnabled && (
              <Input
                type="text"
                value={customSystemPrompt}
                onChange={(e) => handleCustomSystemPromptChange(e.target.value)}
                placeholder={t("customSystemPromptPlaceholder")}
                className="w-64 text-xs"
              />
            )}
            <Toggle
              checked={customSystemPromptEnabled}
              onChange={handleCustomSystemPromptEnabledChange}
              ariaLabel={t("customSystemPromptTitle")}
              size="sm"
            />
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-semibold">{t("available")}</h2>
            <p className="text-sm text-text-muted">
              {modelsLoading
                ? translateOrFallback("loadingModels", "Loading available models...")
                : t("modelsAcrossEndpoints", {
                    models: totalEndpointModelCount,
                    endpoints: availableEndpointCount,
                  })}
            </p>
          </div>
        </div>

        {/* Core APIs */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-sm text-primary">hub</span>
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              {t("categoryCore") || "Core APIs"}
            </h3>
            <div className="flex-1 h-px bg-border/50" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            <EndpointCard
              icon="chat"
              iconColor="text-blue-500"
              iconBg="bg-blue-500/10"
              title={t("chatCompletions")}
              path="/v1/chat/completions"
              models={endpointData.chat}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="code"
              iconColor="text-indigo-500"
              iconBg="bg-indigo-500/10"
              title={t("responses") || "Responses API"}
              path="/v1/responses"
              models={endpointData.chat}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="text_fields"
              iconColor="text-orange-500"
              iconBg="bg-orange-500/10"
              title={t("completionsLegacy") || "Completions (Legacy)"}
              path="/v1/completions"
              models={endpointData.chat}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="psychology"
              iconColor="text-violet-500"
              iconBg="bg-violet-500/10"
              title={t("messagesApi") || "Messages"}
              path="/v1/messages"
              models={null}
              badge="Anthropic"
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
            />
          </div>
        </div>

        {/* Media & Multi-Modal */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-sm text-purple-400">perm_media</span>
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              {t("categoryMedia") || "Media & Multi-Modal"}
            </h3>
            <div className="flex-1 h-px bg-border/50" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            <EndpointCard
              icon="data_array"
              iconColor="text-emerald-500"
              iconBg="bg-emerald-500/10"
              title={t("embeddings")}
              path="/v1/embeddings"
              models={endpointData.embeddings}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="image"
              iconColor="text-purple-500"
              iconBg="bg-purple-500/10"
              title={t("imageGeneration")}
              path="/v1/images/generations"
              models={endpointData.images}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="edit_square"
              iconColor="text-violet-500"
              iconBg="bg-violet-500/10"
              title={t("imageEdits") || "Image Edits"}
              path="/v1/images/edits"
              models={endpointData.images}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="mic"
              iconColor="text-rose-500"
              iconBg="bg-rose-500/10"
              title={t("audioTranscription")}
              path="/v1/audio/transcriptions"
              models={endpointData.audioTranscription}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="record_voice_over"
              iconColor="text-cyan-500"
              iconBg="bg-cyan-500/10"
              title={t("textToSpeech")}
              path="/v1/audio/speech"
              models={endpointData.audioSpeech}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="music_note"
              iconColor="text-fuchsia-500"
              iconBg="bg-fuchsia-500/10"
              title={t("musicGeneration") || "Music Generation"}
              path="/v1/music/generations"
              models={endpointData.music}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="videocam"
              iconColor="text-red-500"
              iconBg="bg-red-500/10"
              title={t("videoGeneration") || "Video Generation"}
              path="/v1/videos/generations"
              models={endpointData.video}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
          </div>
        </div>

        {/* Search & Discovery */}
        {searchProviders.length > 0 && (
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-sm text-cyan-400">
                travel_explore
              </span>
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                {t("categorySearch") || "Search & Discovery"}
              </h3>
              <div className="flex-1 h-px bg-border/50" />
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
              <EndpointCard
                icon="search"
                iconColor="text-cyan-500"
                iconBg="bg-cyan-500/10"
                title={t("webSearch") || "Web Search"}
                path="/v1/search"
                models={searchProviders.map((p) => ({ id: p.id, owned_by: p.id, type: "search" }))}
                copy={copy}
                copied={copied}
                baseUrl={currentEndpoint}
              />
            </div>
          </div>
        )}

        {/* Utility & Management */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-sm text-amber-400">build</span>
            <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
              {t("categoryUtility") || "Utility & Management"}
            </h3>
            <div className="flex-1 h-px bg-border/50" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            <EndpointCard
              icon="sort"
              iconColor="text-amber-500"
              iconBg="bg-amber-500/10"
              title={t("rerank")}
              path="/v1/rerank"
              models={endpointData.rerank}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="shield"
              iconColor="text-orange-500"
              iconBg="bg-orange-500/10"
              title={t("moderations")}
              path="/v1/moderations"
              models={endpointData.moderation}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
              modelsLoading={modelsLoading}
            />
            <EndpointCard
              icon="view_list"
              iconColor="text-teal-500"
              iconBg="bg-teal-500/10"
              title={t("batchApi") || "Batch API"}
              path="/v1/batches"
              models={null}
              badge="OpenAI"
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
            />
            <EndpointCard
              icon="folder"
              iconColor="text-yellow-500"
              iconBg="bg-yellow-500/10"
              title={t("filesApi") || "Files API"}
              path="/v1/files"
              models={null}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
            />
            <EndpointCard
              icon="list"
              iconColor="text-teal-500"
              iconBg="bg-teal-500/10"
              title={t("listModels") || "List Models"}
              path="/v1/models"
              models={null}
              copy={copy}
              copied={copied}
              baseUrl={currentEndpoint}
            />
          </div>

          <VscodeTokenAliasCard className="mt-4" />
        </div>
      </Card>

      {/* Cloud Enable Modal */}
      <Modal
        isOpen={showCloudModal}
        title={t("enableCloudTitle")}
        onClose={() => setShowCloudModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <p className="text-sm text-blue-800 dark:text-blue-200 font-medium mb-2">
              {t("whatYouGet")}
            </p>
            <ul className="text-sm text-blue-700 dark:text-blue-300 space-y-1">
              <li>• {t("cloudBenefitAccess")}</li>
              <li>• {t("cloudBenefitShare")}</li>
              <li>• {t("cloudBenefitPorts")}</li>
              <li>• {t("cloudBenefitEdge")}</li>
            </ul>
          </div>

          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 font-medium mb-1">
              {tc("note")}
            </p>
            <ul className="text-sm text-yellow-700 dark:text-yellow-300 space-y-1">
              <li>• {t("cloudSessionNote")}</li>
              <li>• {t("cloudUnstableNote")}</li>
            </ul>
          </div>

          {/* Sync Progress / Success */}
          {(cloudSyncing || modalSuccess) && (
            <div
              className={`flex items-center gap-3 p-3 rounded-lg border transition-all duration-300 ${
                modalSuccess
                  ? "bg-green-500/10 border-green-500/30"
                  : "bg-primary/10 border-primary/30"
              }`}
            >
              {modalSuccess ? (
                <span className="material-symbols-outlined text-green-500 text-xl">
                  check_circle
                </span>
              ) : (
                <span className="material-symbols-outlined animate-spin text-primary">
                  progress_activity
                </span>
              )}
              <div className="flex-1">
                <p
                  className={`text-sm font-medium ${
                    modalSuccess ? "text-green-500" : "text-primary"
                  }`}
                >
                  {modalSuccess && t("cloudConnected")}
                  {!modalSuccess && syncStep === "syncing" && t("connectingToCloud")}
                  {!modalSuccess && syncStep === "verifying" && t("verifyingConnection")}
                </p>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleEnableCloud} fullWidth disabled={cloudSyncing || modalSuccess}>
              {cloudSyncing ? (
                <span className="flex items-center gap-2">
                  <span className="material-symbols-outlined animate-spin text-sm">
                    progress_activity
                  </span>
                  {syncStep === "syncing" ? t("connecting") : t("verifying")}
                </span>
              ) : modalSuccess ? (
                <span className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-sm">check</span>
                  {t("connected")}
                </span>
              ) : (
                t("enableCloud")
              )}
            </Button>
            <Button
              onClick={() => setShowCloudModal(false)}
              variant="ghost"
              fullWidth
              disabled={cloudSyncing || modalSuccess}
            >
              {tc("cancel")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Disable Cloud Modal */}
      <Modal
        isOpen={showDisableModal}
        title={t("disableCloudTitle")}
        onClose={() => !cloudSyncing && setShowDisableModal(false)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined text-red-600 dark:text-red-400">
                warning
              </span>
              <div>
                <p className="text-sm text-red-800 dark:text-red-200 font-medium mb-1">
                  {tc("warning")}
                </p>
                <p className="text-sm text-red-700 dark:text-red-300">{t("disableWarning")}</p>
              </div>
            </div>
          </div>

          {/* Sync Progress */}
          {cloudSyncing && (
            <div className="flex items-center gap-3 p-3 bg-primary/10 border border-primary/30 rounded-lg">
              <span className="material-symbols-outlined animate-spin text-primary">
                progress_activity
              </span>
              <div className="flex-1">
                <p className="text-sm font-medium text-primary">
                  {syncStep === "syncing" && t("syncingData")}
                  {syncStep === "disabling" && t("disablingCloud")}
                </p>
              </div>
            </div>
          )}

          <p className="text-sm text-text-muted">{t("disableConfirm")}</p>

          <div className="flex gap-2">
            <Button
              onClick={handleConfirmDisable}
              fullWidth
              disabled={cloudSyncing}
              className="bg-red-500! hover:bg-red-600! text-white!"
            >
              {cloudSyncing ? (
                <span className="flex items-center gap-2">
                  <span className="material-symbols-outlined animate-spin text-sm">
                    progress_activity
                  </span>
                  {syncStep === "syncing" ? t("syncing") : t("disabling")}
                </span>
              ) : (
                t("disableCloud")
              )}
            </Button>
            <Button
              onClick={() => setShowDisableModal(false)}
              variant="ghost"
              fullWidth
              disabled={cloudSyncing}
            >
              {tc("cancel")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Provider Models Popup */}
      {selectedProvider && (
        <ProviderModelsModal
          provider={selectedProvider}
          models={allModels}
          copy={copy}
          copied={copied}
          onClose={() => setSelectedProvider(null)}
        />
      )}
    </div>
  );
}

// -- Sub-component: Provider Models Modal ------------------------------------------

function ProviderModelsModal({
  provider,
  models,
  copy,
  copied,
  onClose,
}: Readonly<{
  provider: EndpointProviderSummary;
  models: EndpointModelSummary[];
  copy: CopyHandler;
  copied?: string | null;
  onClose: () => void;
}>) {
  const t = useTranslations("endpoint");
  const tc = useTranslations("common");
  // Get provider alias for matching models
  // Filter out parent models (models with parent field set) to avoid showing duplicates
  const providerAlias = provider.provider.alias || provider.id;
  const providerModels = useMemo(() => {
    return models.filter(
      (m) => !m.parent && (m.owned_by === providerAlias || m.owned_by === provider.id)
    );
  }, [models, providerAlias, provider.id]);

  const chatModels = providerModels.filter((m) => !m.type);
  const embeddingModels = providerModels.filter((m) => m.type === "embedding");
  const imageModels = providerModels.filter((m) => m.type === "image");

  const renderModelGroup = (title, icon, groupModels) => {
    if (groupModels.length === 0) return null;
    return (
      <div className="mb-4">
        <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-sm">{icon}</span>
          {title} ({groupModels.length})
        </h4>
        <div className="flex flex-col gap-1">
          {groupModels.map((m) => {
            const copyKey = `modal-${m.id}`;
            return (
              <div
                key={m.id}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-surface/60 group"
              >
                <code className="text-sm font-mono flex-1 truncate">{m.id}</code>
                {m.custom && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                    {t("custom")}
                  </span>
                )}
                <button
                  onClick={() => copy(m.id, copyKey)}
                  className="p-1 hover:bg-sidebar rounded text-text-muted hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                  title={tc("copy")}
                >
                  <span className="material-symbols-outlined text-sm">
                    {copied === copyKey ? "check" : "content_copy"}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t("providerModelsTitle", { provider: provider.provider.name })}
    >
      <div className="max-h-[60vh] overflow-y-auto">
        {providerModels.length === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">{t("noModelsForProvider")}</p>
        ) : (
          <>
            {renderModelGroup(t("chat"), "chat", chatModels)}
            {renderModelGroup(t("embedding"), "data_array", embeddingModels)}
            {renderModelGroup(t("image"), "image", imageModels)}
          </>
        )}
      </div>
    </Modal>
  );
}

// -- Sub-component: Endpoint Section ------------------------------------------

function EndpointCard({
  icon,
  iconColor,
  iconBg,
  title,
  path,
  models,
  copy,
  copied,
  baseUrl,
  badge,
  modelsLoading = false,
}: Readonly<{
  icon: string;
  iconColor: string;
  iconBg: string;
  title: string;
  path: string;
  models: EndpointModelSummary[] | null;
  copy: CopyHandler;
  copied?: string | null;
  baseUrl: string;
  badge?: string;
  modelsLoading?: boolean;
}>) {
  const t = useTranslations("endpoint");
  const copyId = `endpoint_${path}`;
  const fullUrl = `${baseUrl.replace(/\/v1$/, "")}${path}`;

  return (
    <div className="border border-border rounded-lg p-3 hover:bg-surface/30 transition-colors flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <div className={`flex items-center justify-center size-8 rounded-lg ${iconBg} shrink-0`}>
          <span className={`material-symbols-outlined text-base ${iconColor}`}>{icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-semibold text-xs leading-tight">{title}</span>
            {badge && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full border border-border/60 text-text-muted font-medium uppercase tracking-wider leading-none">
                {badge}
              </span>
            )}
          </div>
          <span className="text-xs text-text-muted mt-0.5 block">
            {models === null
              ? "—"
              : modelsLoading
                ? "..."
                : t("modelsCount", { count: models.length })}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <code className="flex-1 text-[10px] font-mono text-text-muted bg-surface/80 px-2 py-1 rounded truncate">
          {path}
        </code>
        <button
          onClick={() => void copy(fullUrl, copyId)}
          className="shrink-0 flex items-center justify-center size-6 rounded hover:bg-sidebar transition-colors"
          title={t("copyUrl")}
        >
          <span className="material-symbols-outlined text-[12px] text-text-muted">
            {copied === copyId ? "check" : "content_copy"}
          </span>
        </button>
      </div>
    </div>
  );
}

function EndpointSection({
  icon,
  iconColor,
  iconBg,
  title,
  path,
  description,
  models,
  expanded,
  onToggle,
  copy,
  copied,
  baseUrl,
  modelsLoading = false,
}: Readonly<{
  icon: string;
  iconColor: string;
  iconBg: string;
  title: string;
  path: string;
  description: string;
  models: EndpointModelSummary[];
  expanded: boolean;
  onToggle: () => void;
  copy: CopyHandler;
  copied?: string | null;
  baseUrl: string;
  modelsLoading?: boolean;
}>) {
  const t = useTranslations("endpoint");
  const grouped = useMemo(() => {
    const map = {};
    for (const m of models) {
      const owner = m.owned_by || "unknown";
      if (!map[owner]) map[owner] = [];
      map[owner].push(m);
    }
    return Object.entries(map).sort((a: any, b: any) => b[1].length - a[1].length);
  }, [models]);

  const resolveProvider = (id) => AI_PROVIDERS[id] || getProviderByAlias(id);
  const providerColor = (id) => resolveProvider(id)?.color || "#888";
  const providerName = (id) => getProviderDisplayName(id, resolveProvider(id));
  const copyId = `endpoint_${path}`;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Header (always visible) */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 hover:bg-surface/50 transition-colors text-left"
      >
        <div className={`flex items-center justify-center size-10 rounded-lg ${iconBg} shrink-0`}>
          <span className={`material-symbols-outlined text-xl ${iconColor}`}>{icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{title}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-surface text-text-muted font-medium">
              {modelsLoading ? "..." : t("modelsCount", { count: models.length })}
            </span>
          </div>
          <p className="text-xs text-text-muted mt-0.5">{description}</p>
        </div>
        <span
          className={`material-symbols-outlined text-text-muted text-lg transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          expand_more
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border px-4 pb-4">
          {/* Endpoint path + copy */}
          <div className="flex items-center gap-2 mt-3 mb-3">
            <code className="flex-1 text-xs font-mono text-text-muted bg-surface/80 px-3 py-1.5 rounded-lg truncate">
              {baseUrl.replace(/\/v1$/, "")}
              {path}
            </code>
            <button
              onClick={() => copy(`${baseUrl.replace(/\/v1$/, "")}${path}`, copyId)}
              className="p-1.5 hover:bg-surface rounded-lg text-text-muted hover:text-primary transition-colors shrink-0"
            >
              <span className="material-symbols-outlined text-[16px]">
                {copied === copyId ? "check" : "content_copy"}
              </span>
            </button>
          </div>

          {/* Models grouped by provider */}
          {modelsLoading ? (
            <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-surface/40 px-3 py-2 text-xs text-text-muted">
              <span className="material-symbols-outlined animate-spin text-sm">
                progress_activity
              </span>
              <span>{t("loadingModels")}</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {grouped.map(([providerId, providerModels]) => (
                <div key={providerId}>
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className="size-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: providerColor(providerId) }}
                    />
                    <span className="text-xs font-semibold text-text-main">
                      {providerName(providerId)}
                    </span>
                    <span className="text-xs text-text-muted">
                      ({(providerModels as any).length})
                    </span>
                  </div>
                  <div className="ml-5 flex flex-wrap gap-1.5">
                    {(providerModels as any).map((m) => (
                      <span
                        key={m.id}
                        className="text-xs px-2 py-0.5 rounded-md bg-surface/80 text-text-muted font-mono"
                        title={m.id}
                      >
                        {m.root || m.id.split("/").pop()}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
