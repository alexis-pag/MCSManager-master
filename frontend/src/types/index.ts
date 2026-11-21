/* eslint-disable no-unused-vars */
import type { Dayjs } from "dayjs";
import type { AiScheduleKind, INSTANCE_STATUS_CODE, ScheduleCreateType } from "./const";

export type JsonData = IJsonData;
export type MapData<T> = IMapData<T>;
export type LayoutCardParams = ILayoutCardParams;
export type LayoutCard = ILayoutCard;

export interface LayoutWithRouter {
  page: string;
  items: LayoutCard[];
}

export enum NEW_CARD_TYPE {
  COMMON = "COMMON",
  INSTANCE = "INSTANCE",
  DATA = "DATA",
  USER = "USER",
  OTHER = "OTHER"
}

// Data-plane mode values. Mirrors `DataPlaneMode` in
// `panel/src/app/entity/setting.ts`; the contract between the two is the
// string wire format (`"direct"` / `"proxy"`), not a shared TS symbol.
export enum DataPlaneMode {
  Direct = "direct",
  Proxy = "proxy"
}

export interface InstanceRuntimeInfo {
  mcPingOnline: boolean;
  currentPlayers: number;
  maxPlayers: number;
  version: string;
  fileLock: number;
  playersChart: { value: string }[];
  openFrpStatus: boolean;
  latency: number;
  cpuUsage?: number;
  memoryUsagePercent?: number;
  rxBytes?: number;
  txBytes?: number;
  rxRate?: number;
  txRate?: number;
  networkInterfaces?: string[];
  networkStatsSource?: "docker";
  readBytes?: number;
  writeBytes?: number;
  memoryUsage?: number;
  memoryLimit?: number;
  storageUsage?: number;
  storageLimit?: number;
  allocatedPorts?: {
    host: string;
    container: number;
    protocol: string;
  }[];
}

export interface InstanceDetail {
  instanceUuid: string;
  started: number;
  autoRestarted: number;
  status: INSTANCE_STATUS_CODE;
  info: InstanceRuntimeInfo;
  config: IGlobalInstanceConfig;
  watcher?: number;
}

export interface NodeStatus {
  available: boolean;
  ip: string;
  port: number;
  remarks: string;
  uuid: string;
}

export interface Settings {
  httpPort: number;
  httpIp: any;
  reverseProxyMode: boolean;
  reverseProxyHeader: string;
  dataPort: number;
  forwardType: number;
  dataPlane: DataPlaneMode;
  crossDomain: boolean;
  gzip: boolean;
  maxCompress: number;
  maxDownload: number;
  zipType: number;
  totpDriftToleranceSteps: number;
  loginCheckIp: boolean;
  loginInfo: string;
  canFileManager: boolean;
  language: string;
  presetPackAddr: string;
  redisUrl: string;
  allowUsePreset: boolean;
  businessMode: boolean;
  businessId: string;
  allowChangeCmd: boolean;
  enableApiKey: boolean | "ONLY_ADMIN";
  registerCode: string;
  panelId: string;
  ssoEnabled: boolean;
  ssoOnlyMode: boolean;
  ssoAutoRedirect: boolean;
  ssoProviderName: string;
  ssoIconUrl: string;
  ssoIssuer: string;
  ssoClientId: string;
  ssoClientSecret: string;
  ssoTokenAuthMethod: string;
  ssoCallbackUrl: string;
  operationLogEnabled: boolean;
  operationLogMaxLinesPerFile: number;
  operationLogKeepDays: number;
  operationLogMaxTotalLines: number;
  operationLogRecordLogin: boolean;
  operationLogRecordInstance: boolean;
  operationLogRecordFile: boolean;
  operationLogRecordUser: boolean;
  operationLogRecordSystem: boolean;
  // Auto update (panel self-update)
  updateSourceUrl: string;
  // Backup update source: tried when the primary source cannot be fetched
  updateSourceUrlFallback: string;
}

export interface ImageInfo {
  Containers: number;
  Created: number;
  Id: string;
  Labels: null;
  ParentId: string;
  RepoDigests: string[];
  RepoTags: string[];
  SharedSize: number;
  Size: number;
  VirtualSize: number;
}

export interface DockerNetworkModes {
  Name: string;
  Id: string;
  Created: string;
  Scope: string;
  Driver: string;
  EnableIPv6: boolean;
  IPAM: {
    Driver: string;
    Options: null;
    Config: [
      {
        Subnet: string;
        Gateway: string;
      }
    ];
  };
  Internal: boolean;
  Attachable: boolean;
  Ingress: boolean;
  ConfigFrom: {
    Network: string;
    [propName: string]: unknown;
  };
  ConfigOnly: boolean;
  Containers: {
    [propName: string]: unknown;
  };
  Options: {
    [propName: string]: unknown;
  };
  Labels: {
    [propName: string]: unknown;
  };
}

export interface ContainerInfo {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Command: string;
  Created: number;
  Ports: {
    IP: string;
    PrivatePort: number;
    PublicPort: number;
    Type: string;
  }[];
  Labels: {
    [propName: string]: unknown;
  };
  State: string;
  Status: string;
  HostConfig: {
    NetworkMode: string;
    [propName: string]: unknown;
  };
  NetworkSettings: {
    Networks: {
      bridge: {
        IPAMConfig: null;
        Links: null;
        Aliases: null;
        NetworkID: string;
        EndpointID: string;
        Gateway: string;
        IPAddress: string;
        IPPrefixLen: number;
        IPv6Gateway: string;
        GlobalIPv6Address: string;
        GlobalIPv6PrefixLen: number;
        MacAddress: string;
        DriverOpts: null;
        [propName: string]: unknown;
      };
      [propName: string]: unknown;
    };
  };
  Mounts: [
    {
      Type: string;
      Source: string;
      Destination: string;
      Mode: string;
      RW: true;
      Propagation: string;
    }
  ];
}

export type QuickStartTemplate = IQuickStartTemplate;
export type QuickStartPackages = IQuickStartPackages;

export interface LabelValueOption {
  label: string;
  value: string;
}

export interface MountComponent<T = any> {
  destroyComponent(delay?: number): void;
  emitResult(data?: T): void;
}

export interface Schedule {
  instanceUuid: string;
  name: string;
  count: number | string;
  time: string;
  actions: ScheduleAction[];
  type: number;
}

export interface ScheduleAction {
  type: string;
  payload: string;
  /** Form-only fields of a backup action, serialized into `payload` on submit. */
  backupPaths?: string;
  backupKeep?: number;
}

/** Scheduled AI task (panel-side, read-only report bound to one instance). */
export interface AiSchedule {
  uuid: string;
  name: string;
  kind: AiScheduleKind;
  prompt: string;
  type: number;
  time: string;
  count: number;
  createdAt: string;
  lastRunAt: string;
  lastStatus: "" | "queued" | "completed" | "failed" | "skipped";
  lastReportUuid: string;
  disabledReason: string;
}

export interface NewScheduleTask {
  name: string;
  count: number | string;
  time: string;
  type: ScheduleCreateType;
  actions?: ScheduleAction[];
  /** Edit: name of the task this one replaces. */
  replaces?: string;
}

/** Answer of a task creation by a regular user: stored until an administrator approves it. */
export interface PendingAutomation {
  pending: true;
  request: AutomationRequest;
}

/** Automation waiting for (or refused by) an administrator. */
export interface AutomationRequest {
  uuid: string;
  kind: "schedule" | "ai_task";
  requesterUuid: string;
  requesterName: string;
  daemonId: string;
  instanceUuid: string;
  instanceName: string;
  name: string;
  payload: {
    name: string;
    type: number;
    time: string;
    count: number;
    actions?: ScheduleAction[];
    kind?: AiScheduleKind;
    prompt?: string;
  };
  replaces: string;
  origin: "new" | "edit" | "migration";
  state: "pending" | "approved" | "refused" | "cancelled";
  createdAt: string;
  decidedAt: string;
  decidedBy: string;
  note: string;
  error: string;
}

export interface ScheduleTaskForm extends NewScheduleTask {
  weekend: number[];
  cycle: string[];
  actions: ScheduleAction[];
  objTime: Dayjs;
  /** "server": daemon actions; "ai": scheduled AI report. */
  category: "server" | "ai";
  kind: AiScheduleKind;
  prompt: string;
}

export interface PanelStatus {
  isInstall: boolean;
  language: string;
  settings: {
    businessMode: boolean;
    businessId: string;
    // Only returned for logged-in users
    canFileManager?: boolean;
    allowUsePreset?: boolean;
    allowChangeCmd?: boolean;
    panelId?: string;
    ssoEnabled?: boolean;
  };
}

/** AI access of the current user (administrators are always "granted"). */
export interface AiAccessView {
  state: "none" | "pending" | "granted" | "refused" | "revoked";
  note?: string;
  requestedAt?: string;
  decidedAt?: string;
}
