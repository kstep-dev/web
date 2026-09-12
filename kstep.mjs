// Shared by index.html (browser) and run.mjs (Node): how to boot a kSTEP image in the
// wasm QEMU and get its output back.
//
//   const { done } = await runKstep(Module, { files, driver, smp, mem, onLine, locateFile });
//   const { panic } = await done;
//
// files: { kernel, rootfs, bios: { 'bios-256k.bin': ..., } } as Uint8Array / ArrayBuffer.
// wasmBinary (optional): the .wasm bytes, if the caller fetched them itself (e.g. to show progress).
// cli (optional): if true, the JSON port (/dev/hvc0 in the guest) is also readable by the
// guest: `send(line)` on the returned object queues a command line for kSTEP's `cli` driver,
// whose replies come back among the 'jsonl' lines (they have an "ok" field, events a "type").
// onLine(channel, line) is called for every complete line, channel 'console' (kernel
// console, chardev 0), 'jsonl' (structured output, chardev 1) or 'cov' (coverage, chardev
// 2). QEMU does not exit on guest reboot under Emscripten, so `done` resolves when the
// console shows the reboot or a kernel panic.

export const BIOS = ['bios-256k.bin', 'linuxboot_dma.bin', 'kvmvapic.bin'];

// kSTEP's run.py arguments for x86_64, plus tsc_early_khz: QEMU on a wasm host derives the
// guest TSC from the JS clock (1 GHz, but only as fine as performance.now(), 1 ms in Safari),
// and the kernel's PIT/HPET TSC calibration divides by zero when two reads coincide.
// `params` are extra kSTEP module parameters after the `--` (topology=, capacity=, ...).
export function bootArgs({ driver, smp, params = {} }) {
  const isol = smp > 2 ? `1-${smp - 1}` : '1';
  return `rw nokaslr loglevel=7 sched_verbose isolcpus=nohz,managed_irq,${isol} irqaffinity=0 ` +
    `rcu_nocbs=${isol} nohz_full=${isol} init=/user panic=-1 console=ttyS0 tsc=nowatchdog ` +
    `tsc_early_khz=1000000 -- driver=${driver}` +
    Object.entries(params).filter(([, v]) => v).map(([k, v]) => ` ${k}=${v}`).join('');
}

export function qemuArgs({ driver, smp, mem, cli = false, params }) {
  return [
    '-smp', String(smp), '-cpu', 'max', '-m', `${mem}M`, '-L', '/bios',
    '-accel', 'tcg,tb-size=64,thread=multi',
    '-kernel', '/kernel', '-initrd', '/rootfs.cpio', '-append', bootArgs({ driver, smp, params }),
    '-nographic', '-nodefaults', '-no-reboot',
    // /dev/kstep0..2 are Emscripten device nodes whose write callbacks push bytes to us
    // (ttyS0 console; hvc0 JSON and hvc1 coverage over virtio console ports, one virtqueue
    // kick per write where the 16550 cost one port I/O exit per byte). The cli driver also
    // reads commands from hvc0, so that one becomes a pipe chardev (opened read-write) on a
    // device whose poll op tells QEMU when a command is waiting.
    '-chardev', 'file,id=c0,path=/dev/kstep0', '-serial', 'chardev:c0',
    '-device', 'virtio-serial-pci,id=vs0',
    '-chardev', `${cli ? 'pipe' : 'file'},id=c1,path=/dev/kstep1`, '-device', 'virtconsole,bus=vs0.0,nr=0,chardev=c1',
    '-chardev', 'file,id=c2,path=/dev/kstep2', '-device', 'virtconsole,bus=vs0.0,nr=1,chardev=c2',
  ];
}

export async function runKstep(Module, { files, driver, smp, mem, onLine, locateFile, wasmBinary, cli = false, params, log = console.error }) {
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });
  const channels = { 0: 'console', 1: 'jsonl', 2: 'cov' };
  const lines = { console: '', jsonl: '', cov: '' };
  const inq = [];   // bytes queued for the guest's hvc0 (cli commands)
  const send = (line) => { for (const b of new TextEncoder().encode(line + '\n')) inq.push(b); };
  const sink = (i) => (byte) => {
    const ch = channels[i];
    if (!ch) return;
    if (byte !== 10) { lines[ch] += String.fromCharCode(byte); return; }
    const line = lines[ch]; lines[ch] = '';
    onLine(ch, line);
    if (ch === 'console' && (line.includes('reboot: Restarting system') || line.includes('Kernel panic')))
      resolveDone({ panic: line.includes('Kernel panic') });
  };
  const module = await Module({
    locateFile, wasmBinary,   // wasmBinary: pass the .wasm bytes if fetched by the caller (for progress)
    arguments: qemuArgs({ driver, smp, mem, cli, params }),
    preRun: [(m) => {
      m.FS.mkdir('/bios');
      for (const [name, data] of Object.entries(files.bios)) m.FS.writeFile(`/bios/${name}`, new Uint8Array(data));
      m.FS.writeFile('/kernel', new Uint8Array(files.kernel));
      m.FS.writeFile('/rootfs.cpio', new Uint8Array(files.rootfs));
      for (let i = 0; i < 3; i++) if (i !== 1 || !cli) m.FS.createDevice('/dev', `kstep${i}`, null, sink(i));
      if (cli) {
        // Bidirectional device for hvc0. FS ops run on the main thread (QEMU's thread is
        // proxied to it), so the queue is plain JS state.
        const out = sink(1), dev = m.FS.makedev(64, 1);
        m.FS.registerDevice(dev, {
          open(stream) { stream.seekable = false; },
          close() {},
          read(stream, buffer, offset, length) {
            let n = 0;
            while (n < length && inq.length) buffer[offset + n++] = inq.shift();
            if (n === 0) throw new m.FS.ErrnoError(6);   // EAGAIN: nothing queued
            return n;
          },
          write(stream, buffer, offset, length) { for (let i = 0; i < length; i++) out(buffer[offset + i]); return length; },
          poll() { return (inq.length ? 1 : 0) | 4; },  // POLLIN when a command is queued, always POLLOUT
        });
        m.FS.mkdev('/dev/kstep1', 0o666, dev);
      }
    }],
    print: (s) => log('[qemu] ' + s),
    printErr: (s) => { if (!s.includes('unsupported syscall')) log('[qemu] ' + s); },
  });
  return { module, done, send };
}
