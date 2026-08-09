import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  DESKTOP_INFERENCE_CHANNELS,
  isDesktopInferenceRequestId,
  parseDesktopAsrPreloadRequest,
  parseDesktopAsrRequest,
  parseDesktopClapRequest,
  parseDesktopRhythmRequest,
  parseDesktopSemanticRequest,
  type DesktopInferenceProgress,
} from '../shared/desktop-inference.ts';
import { assertTrustedDesktopSenderUrl } from './page-origin.ts';
import { NativeAsrService } from './native-asr-service.ts';
import { NativeClapService } from './native-clap-service.ts';
import { NativeRhythmService } from './native-rhythm-service.ts';
import { NativeSemanticService } from './native-semantic-service.ts';
import { NativeInferenceBudget } from './native-inference-budget.ts';
import {
  NativeInferenceResidency,
  estimateAsrResidentBytes,
  modelPackResidentBytes,
  type NativeInferenceKind,
} from './native-inference-residency.ts';

const SEMANTIC_RESIDENT_BYTES = modelPackResidentBytes('visual-semantics-lite');
const CLAP_RESIDENT_BYTES = modelPackResidentBytes('music-semantics-lite');
const RHYTHM_RESIDENT_BYTES = modelPackResidentBytes('rhythm-lite');


interface NativeServices {
  readonly asr: NativeAsrService;
  readonly clap: NativeClapService;
  readonly rhythm: NativeRhythmService;
  readonly semantic: NativeSemanticService;
}


interface ObservedOwner {
  readonly sender: WebContents;
  readonly onDestroyed: () => void;
  readonly onNavigation: (
    _details: unknown,
    _url: string,
    inPlace: boolean,
    mainFrame: boolean,
    _frameProcessId: number,
    _frameRoutingId: number,
  ) => void;
  readonly onRenderProcessGone: () => void;
}

export interface InstalledDesktopInference {
  dispose(): void;
}

function createServices(trustedOrigin: string, cacheDir: string): NativeServices {
  return {
    asr: new NativeAsrService({ cacheDir }),
    semantic: new NativeSemanticService({ origin: trustedOrigin, cacheDir }),
    clap: new NativeClapService({ origin: trustedOrigin, cacheDir }),
    rhythm: new NativeRhythmService({ cacheDir }),
  };
}

function requestInputBytes(request: object): number {
  const samples = Reflect.get(request, 'samples');
  if (samples instanceof Float32Array) return samples.byteLength;
  const frame = Reflect.get(request, 'frame');
  if (typeof frame === 'object' && frame !== null) {
    const data = Reflect.get(frame, 'data');
    if (data instanceof Uint8ClampedArray) return data.byteLength;
  }
  const vectors = Reflect.get(request, 'vectors');
  if (typeof vectors === 'object' && vectors !== null) {
    const values = Reflect.get(vectors, 'values');
    const assetOffsets = Reflect.get(vectors, 'assetVectorOffsets');
    const vectorOffsets = Reflect.get(vectors, 'vectorValueOffsets');
    return (values instanceof Float32Array ? values.byteLength : 0)
      + (assetOffsets instanceof Uint32Array ? assetOffsets.byteLength : 0)
      + (vectorOffsets instanceof Uint32Array ? vectorOffsets.byteLength : 0);
  }
  return 0;
}

class DesktopInferenceState {
  private readonly trustedOrigin: string;
  private readonly cacheDir: string;
  private services: NativeServices;
  private enabled = false;
  private readonly budget = new NativeInferenceBudget();
  private readonly residency = new NativeInferenceResidency();
  private readonly observedOwners = new Map<number, ObservedOwner>();

  constructor(trustedOrigin: string, cacheDir: string) {
    this.trustedOrigin = trustedOrigin;
    this.cacheDir = cacheDir;
    this.services = createServices(trustedOrigin, cacheDir);
  }

  assertTrusted(event: IpcMainInvokeEvent): void {
    assertTrustedDesktopSenderUrl(event.senderFrame?.url ?? '', this.trustedOrigin);
    this.observeOwner(event.sender);
  }

  capabilities(): ReturnType<NativeAsrService['getCapabilities']> {
    const base = this.services.asr.getCapabilities();
    return {
      ...base,
      semantic: this.services.semantic.getCapabilities().semantic,
      clap: this.services.clap.getCapabilities().clap,
      rhythm: this.services.rhythm.getCapabilities().rhythm,
    };
  }

  setEnabled(value: unknown): void {
    if (typeof value !== 'boolean') throw new Error('invalid desktop inference preference');
    if (this.enabled === value) return;
    this.enabled = value;
    if (!value) this.resetServices();
  }

  async request<T>(
    event: IpcMainInvokeEvent,
    requestId: string,
    inputBytes: number,
    kind: NativeInferenceKind,
    residentBytes: number,
    operation: (services: NativeServices, onProgress: (progress: DesktopInferenceProgress) => void) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) throw new Error('desktop native inference is disabled');
    this.budget.claim(event.sender.id, requestId, inputBytes);
    let releaseResidency: (() => void) | undefined;
    try {
      releaseResidency = this.residency.claim(
        kind,
        residentBytes,
        (evictedKind) => this.evictService(evictedKind),
      );
      return await operation(this.services, this.progressSender(event.sender));
    } finally {
      releaseResidency?.();
      this.budget.release(requestId);
    }
  }

  cancel(event: IpcMainInvokeEvent, requestId: unknown): void {
    if (!isDesktopInferenceRequestId(requestId)) throw new Error('invalid desktop inference request id');
    const ownerId = this.budget.ownerOf(requestId);
    if (ownerId === undefined) return;
    if (ownerId !== event.sender.id) throw new Error('desktop inference request owner mismatch');
    this.cancelServices(requestId);
  }

  dispose(): void {
    this.enabled = false;
    for (const requestId of this.budget.requestIds()) this.cancelServices(requestId);
    this.disposeServices();
    for (const owner of this.observedOwners.values()) {
      owner.sender.off('destroyed', owner.onDestroyed);
      owner.sender.off('render-process-gone', owner.onRenderProcessGone);
      owner.sender.off('did-start-navigation', owner.onNavigation);
    }
    this.observedOwners.clear();
  }


  private observeOwner(sender: WebContents): void {
    if (this.observedOwners.has(sender.id)) return;
    const onDestroyed = (): void => {
      this.cancelOwner(sender.id);
      this.observedOwners.delete(sender.id);
    };
    const onRenderProcessGone = (): void => this.cancelOwner(sender.id);
    const onNavigation = (
      _details: unknown,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean,
      _frameProcessId: number,
      _frameRoutingId: number,
    ): void => {
      if (mainFrame && !inPlace) this.cancelOwner(sender.id);
    };
    sender.once('destroyed', onDestroyed);
    sender.on('render-process-gone', onRenderProcessGone);
    sender.on('did-start-navigation', onNavigation);
    this.observedOwners.set(sender.id, { sender, onDestroyed, onRenderProcessGone, onNavigation });
  }

  private cancelOwner(ownerId: number): void {
    for (const requestId of this.budget.requestIds(ownerId)) this.cancelServices(requestId);
  }

  private progressSender(sender: WebContents): (progress: DesktopInferenceProgress) => void {
    return (progress) => {
      if (!sender.isDestroyed()) sender.send(DESKTOP_INFERENCE_CHANNELS.progress, progress);
    };
  }

  private cancelServices(requestId: string): void {
    this.services.asr.cancel(requestId);
    this.services.semantic.cancel(requestId);
    this.services.clap.cancel(requestId);
    this.services.rhythm.cancel(requestId);
  }

  private disposeServices(): void {
    this.services.asr.dispose();
    this.services.semantic.dispose();
    this.services.clap.dispose();
    this.services.rhythm.dispose();
  }
  private evictService(kind: NativeInferenceKind): void {
    if (kind === 'asr') {
      this.services.asr.dispose();
      this.services = { ...this.services, asr: new NativeAsrService({ cacheDir: this.cacheDir }) };
    } else if (kind === 'semantic') {
      this.services.semantic.dispose();
      this.services = {
        ...this.services,
        semantic: new NativeSemanticService({ origin: this.trustedOrigin, cacheDir: this.cacheDir }),
      };
    } else if (kind === 'clap') {
      this.services.clap.dispose();
      this.services = {
        ...this.services,
        clap: new NativeClapService({ origin: this.trustedOrigin, cacheDir: this.cacheDir }),
      };
    } else {
      this.services.rhythm.dispose();
      this.services = { ...this.services, rhythm: new NativeRhythmService({ cacheDir: this.cacheDir }) };
    }
  }


  private resetServices(): void {
    for (const requestId of this.budget.requestIds()) this.cancelServices(requestId);
    this.disposeServices();
    this.services = createServices(this.trustedOrigin, this.cacheDir);
    this.residency.clear();
  }
}

function registerInferenceHandlers(state: DesktopInferenceState): void {
  ipcMain.handle(DESKTOP_INFERENCE_CHANNELS.capabilities, (event) => {
    state.assertTrusted(event);
    return state.capabilities();
  });
  ipcMain.handle(DESKTOP_INFERENCE_CHANNELS.setEnabled, (event, value: unknown) => {
    state.assertTrusted(event);
    state.setEnabled(value);
  });
  ipcMain.handle(DESKTOP_INFERENCE_CHANNELS.preloadAsr, (event, value: unknown) => {
    state.assertTrusted(event);
    const request = parseDesktopAsrPreloadRequest(value);
    const residentBytes = estimateAsrResidentBytes(request.modelId, request.revision);
    return state.request(event, request.requestId, 0, 'asr', residentBytes,
      (services, progress) => services.asr.preload(request, progress));
  });
  ipcMain.handle(DESKTOP_INFERENCE_CHANNELS.transcribe, (event, value: unknown) => {
    state.assertTrusted(event);
    const request = parseDesktopAsrRequest(value);
    const residentBytes = estimateAsrResidentBytes(request.modelId, request.revision);
    return state.request(event, request.requestId, 0, 'asr', residentBytes,
      (services, progress) => services.asr.transcribe(request, progress));
  });
  ipcMain.handle(DESKTOP_INFERENCE_CHANNELS.semantic, (event, value: unknown) => {
    state.assertTrusted(event);
    const request = parseDesktopSemanticRequest(value);
    const residentBytes = request.action === 'find-duplicates' ? 0 : SEMANTIC_RESIDENT_BYTES;
    return state.request(event, request.requestId, requestInputBytes(request), 'semantic', residentBytes,
      (services, progress) => services.semantic.request(request, progress));
  });
  ipcMain.handle(DESKTOP_INFERENCE_CHANNELS.clap, (event, value: unknown) => {
    state.assertTrusted(event);
    const request = parseDesktopClapRequest(value);
    return state.request(event, request.requestId, requestInputBytes(request), 'clap', CLAP_RESIDENT_BYTES,
      (services, progress) => services.clap.request(request, progress));
  });
  ipcMain.handle(DESKTOP_INFERENCE_CHANNELS.rhythm, (event, value: unknown) => {
    state.assertTrusted(event);
    const request = parseDesktopRhythmRequest(value);
    return state.request(event, request.requestId, requestInputBytes(request), 'rhythm', RHYTHM_RESIDENT_BYTES,
      (services, progress) => services.rhythm.request(request, progress));
  });
  ipcMain.handle(DESKTOP_INFERENCE_CHANNELS.cancel, (event, requestId: unknown) => {
    state.assertTrusted(event);
    state.cancel(event, requestId);
  });
}

export function installDesktopInferenceIpc(
  trustedOrigin: string,
  cacheDir: string,
): InstalledDesktopInference {
  const state = new DesktopInferenceState(trustedOrigin, cacheDir);
  registerInferenceHandlers(state);
  return {
    dispose: () => {
      for (const channel of Object.values(DESKTOP_INFERENCE_CHANNELS)) {
        if (channel !== DESKTOP_INFERENCE_CHANNELS.progress) ipcMain.removeHandler(channel);
      }
      state.dispose();
    },
  };
}
