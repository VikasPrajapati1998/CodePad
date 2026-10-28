(() => {
  type InstallStatus = Parameters<Parameters<CodePadInstallApi['onProgress']>[0]>[0];

  const api = window.codepadInstall;

  /** An element the install page must contain; a missing one is a broken page. */
  function byId<T extends HTMLElement>(id: string, type: new () => T): T {
    const node = document.getElementById(id);
    if (!(node instanceof type)) {
      throw new Error(`The page has no usable #${id} element.`);
    }
    return node;
  }

  const title = byId('title', HTMLElement);
  const bar = byId('bar', HTMLProgressElement);
  const detail = byId('detail', HTMLElement);
  const cancel = byId('cancel', HTMLButtonElement);

  const MB = 1024 * 1024;
  const SECONDS_PER_MINUTE = 60;

  const megabytes = (bytes: number): number => Math.round(bytes / MB);

  function formatEta(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
      return '';
    }
    return seconds < SECONDS_PER_MINUTE
      ? ' - less than a minute left'
      : ` - about ${Math.ceil(seconds / SECONDS_PER_MINUTE)} min left`;
  }

  function describe(status: InstallStatus): string {
    switch (status.state) {
      case 'offline':
        return 'No connection. Waiting to retry...';
      case 'verifying':
        return 'Verifying the download...';
      case 'ready':
        return 'Done.';
      case 'error':
        return status.error && status.error.message ? status.error.message : 'The download failed.';
      default:
        break;
    }
    if (status.external) {
      return 'Another CodePad process is downloading the model. Waiting...';
    }
    if (!status.total) {
      return 'Starting...';
    }
    const speed = status.bytesPerSec > 0 ? ` - ${(status.bytesPerSec / MB).toFixed(1)} MB/s` : '';
    return `${megabytes(status.bytes)} of ${megabytes(status.total)} MB${speed}${formatEta(status.etaSec)}`;
  }

  function render(status: InstallStatus): void {
    if (!status || typeof status !== 'object') {
      return;
    }
    const percent = status.total > 0 ? Math.min(100, Math.floor((status.bytes / status.total) * 100)) : 0;
    bar.value = percent;
    title.textContent = status.total > 0 && status.state === 'downloading'
      ? `Downloading the CodePad AI model... ${percent}%`
      : 'Downloading the CodePad AI model...';
    detail.textContent = describe(status);
  }

  cancel.addEventListener('click', () => {
    cancel.disabled = true;
    detail.textContent = 'Cancelling...';
    api.cancel();
  });
  api.onProgress(render);
})();
