# This exercises a controlled Discord-shaped surface, not a live Discord account.
# Native IPC, Vesktop, TLS, Zipline, and the downloaded upload bytes are real.
{
  pkgs,
  vesktop,
  fixture,
  zipline,
}:
let
  node = "${pkgs.nodejs_24}/bin/node";
  proxy = pkgs.writeText "pelican-test-proxy.mjs" ''
    import { createServer as httpsServer } from 'node:https';
    import { createServer, request } from 'node:http';
    import { readFile, stat } from 'node:fs/promises';
    import { createReadStream } from 'node:fs';
    import { resolve, extname } from 'node:path';

    const root = '${fixture}/share/pelican-test';
    const requests = [];
    const pending = new Set();
    let paused = false;
    const json = (res, body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const server = httpsServer({
      key: await readFile('/run/pelican/server.key'),
      cert: await readFile('/run/pelican/server.crt'),
    }, async (req, res) => {
      const host = req.headers.host;
      const recorded = { method: req.method, host, protocol: 'https:', path: req.url };
      requests.push(recorded);
      try {
        if (host === 'discord.com') {
          const pathname = decodeURIComponent(new URL(req.url, 'https://discord.com').pathname);
          let file = resolve(root, '.' + pathname);
          if (!file.startsWith(root + '/') && file !== root) {
            res.writeHead(403); res.end(); return;
          }
          const info = await stat(file).catch(() => null);
          if (!info?.isFile()) file = root + '/index.html';
          const type = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[extname(file)] || 'application/octet-stream';
          res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
          createReadStream(file).pipe(res);
          return;
        }
        if (host !== 'shares.example.test') {
          res.writeHead(421); res.end(); return;
        }
        if (paused && req.method === 'POST' && req.url.startsWith('/api/upload')) {
          const gate = Promise.withResolvers();
          pending.add(gate);
          req.once('aborted', () => { pending.delete(gate); gate.resolve(); });
          await gate.promise;
          pending.delete(gate);
          if (req.destroyed) return;
        }
        const upstream = request({
          hostname: '127.0.0.1', port: 3002, method: req.method, path: req.url,
          headers: { ...req.headers, host: 'shares.example.test', 'x-forwarded-proto': 'https' },
        }, reply => {
          recorded.status = reply.statusCode;
          res.writeHead(reply.statusCode, reply.headers);
          reply.pipe(res);
        });
        upstream.on('error', error => {
          console.error(error);
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.once('aborted', () => upstream.destroy());
        res.once('close', () => { if (!res.writableFinished) upstream.destroy(); });
        req.pipe(upstream);
      } catch (error) {
        console.error(error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    server.listen(443, '127.0.0.1');
    createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/state') {
        json(res, { requests, pendingUploads: pending.size });
      } else if (req.method === 'POST' && req.url === '/pause') {
        paused = true; json(res, { paused });
      } else if (req.method === 'POST' && req.url === '/release') {
        paused = false;
        for (const gate of pending) gate.resolve();
        pending.clear();
        json(res, { paused });
      } else {
        res.writeHead(404); res.end();
      }
    }).listen(3003, '127.0.0.1');
  '';
  seed = pkgs.writeText "pelican-test-seed.mjs" ''
    import assert from 'node:assert/strict';
    import { randomBytes } from 'node:crypto';
    import { writeFile, chown, chmod } from 'node:fs/promises';
    async function api(path, { method = 'GET', body, cookie } = {}) {
      const response = await fetch('https://shares.example.test' + path, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.ok(response.ok, method + ' ' + path + ': ' + response.status);
      return { data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    const password = randomBytes(32).toString('hex');
    await api('/api/setup', { method: 'POST', body: { username: 'vm-admin', password } });
    const admin = await api('/api/auth/login', { method: 'POST', body: { username: 'vm-admin', password } });
    assert.ok(admin.cookie);
    await api('/api/users', { method: 'POST', cookie: admin.cookie, body: { username: 'vm-user', password, role: 'USER' } });
    const user = await api('/api/auth/login', { method: 'POST', body: { username: 'vm-user', password } });
    assert.ok(user.cookie);
    const identity = await api('/api/user', { cookie: user.cookie });
    assert.equal(identity.data.user.role, 'USER');
    const token = await api('/api/user/token', { cookie: user.cookie });
    assert.equal(typeof token.data.token, 'string');
    assert.ok(token.data.token.length > 0);
    await writeFile('/run/pelican/token', token.data.token, { mode: 0o400 });
    await chown('/run/pelican/token', 1000, 100);
    await chmod('/run/pelican/token', 0o400);
    await writeFile('/run/pelican/user.json', JSON.stringify({ id: identity.data.user.id, role: 'USER', cookie: user.cookie }), { mode: 0o600 });
    console.log('Disposable Zipline USER enrolled; driver-only token fixture mode 0400');
  '';
  ownership = pkgs.writeText "pelican-test-ownership.mjs" ''
    import assert from 'node:assert/strict';
    import { readFile, writeFile } from 'node:fs/promises';
    const user = JSON.parse(await readFile('/run/pelican/user.json', 'utf8'));
    const result = JSON.parse(await readFile('/tmp/pelican-artifacts/result.json', 'utf8'));
    assert.equal(result.ok, true);
    assert.ok(result.downloads.length > 0);
    const identityResponse = await fetch('https://shares.example.test/api/user', { headers: { Cookie: user.cookie } });
    assert.equal(identityResponse.status, 200);
    const identity = (await identityResponse.json()).user;
    assert.equal(identity.id, user.id);
    assert.equal(identity.role, 'USER');
    // This endpoint filters by the authenticated user's ID and omits userId
    // from its response; listing membership proves ownership, not public access.
    const response = await fetch('https://shares.example.test/api/user/files?page=1&perpage=100', { headers: { Cookie: user.cookie } });
    assert.equal(response.status, 200);
    const listing = await response.json();
    const verified = [];
    for (const download of result.downloads) {
      const url = new URL(download.url);
      assert.equal(url.origin, 'https://shares.example.test');
      const name = decodeURIComponent(url.pathname.split('/').pop());
      const file = listing.page.find(file => file.name === name);
      assert.ok(file, 'Downloaded file belongs to the seeded USER: ' + name);
      assert.equal(Number(file.size), download.bytes);
      verified.push({ name, userId: identity.id, bytes: download.bytes, sha256: download.sha256 });
    }
    await writeFile('/tmp/pelican-artifacts/ownership.json', JSON.stringify({ role: user.role, files: verified }, null, 2));
    console.log(JSON.stringify({ role: user.role, ownedDownloads: verified.length }));
  '';
in
pkgs.testers.runNixOSTest {
  name = "pelican-vesktop-zipline";
  globalTimeout = 1800;
  nodes.machine = { ... }: {
    imports = [ (pkgs.path + "/nixos/tests/common/x11.nix") ];
    virtualisation = {
      memorySize = 6144;
      cores = 4;
      diskSize = 12288;
      resolution = {
        x = 1280;
        y = 900;
      };
    };
    users.users.desktop = {
      isNormalUser = true;
      uid = 1000;
      extraGroups = [
        "video"
        "audio"
      ];
    };
    test-support.displayManager.auto.user = "desktop";
    networking.hosts."127.0.0.1" = [
      "discord.com"
      "shares.example.test"
    ];
    # No fallback DNS, external Discord access, or production upload is possible.
    networking.nftables = {
      enable = true;
      tables.pelican-isolation = {
        family = "inet";
        content = ''
          chain output {
            type filter hook output priority 0; policy drop;
            oifname "lo" accept
            counter reject
          }
        '';
      };
    };
    environment.systemPackages = [
      pkgs.curl
      pkgs.nssTools
      pkgs.openssl
      pkgs.nodejs_24
      vesktop
      fixture
    ];
    environment.variables.NODE_EXTRA_CA_CERTS = "/run/pelican/ca.crt";
    systemd.tmpfiles.rules = [
      "d /run/pelican 0755 root root -"
      "d /tmp/pelican-artifacts 0755 root root -"
      "d /var/lib/pelican-zipline 0700 zipline zipline -"
      "d /var/lib/pelican-zipline/uploads 0700 zipline zipline -"
      "d /var/lib/pelican-zipline/tmp 0700 zipline zipline -"
    ];
    users.users.zipline = {
      isSystemUser = true;
      group = "zipline";
    };
    users.groups.zipline = { };
    systemd.services.pelican-certificates = {
      wantedBy = [ "multi-user.target" ];
      before = [
        "pelican-proxy.service"
        "pelican-zipline.service"
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      path = [
        pkgs.openssl
        pkgs.nssTools
        pkgs.coreutils
      ];
      script = ''
        umask 077
        openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
          -subj '/CN=Pelican disposable VM CA' \
          -addext 'basicConstraints=critical,CA:TRUE' \
          -keyout /run/pelican/ca.key -out /run/pelican/ca.crt
        openssl req -newkey rsa:2048 -nodes \
          -subj '/CN=discord.com' \
          -keyout /run/pelican/server.key -out /run/pelican/server.csr
        printf '%s\n' 'subjectAltName=DNS:discord.com,DNS:shares.example.test' \
          'extendedKeyUsage=serverAuth' > /run/pelican/extensions
        openssl x509 -req -in /run/pelican/server.csr -CA /run/pelican/ca.crt \
          -CAkey /run/pelican/ca.key -CAcreateserial -days 2 \
          -extfile /run/pelican/extensions -out /run/pelican/server.crt
        chmod 0444 /run/pelican/ca.crt /run/pelican/server.crt
        install -d -m 0700 -o desktop -g users /home/desktop/.pki /home/desktop/.pki/nssdb
        certutil -N --empty-password -d sql:/home/desktop/.pki/nssdb
        certutil -A -d sql:/home/desktop/.pki/nssdb -n pelican-vm-ca -t 'C,,' -i /run/pelican/ca.crt
        chown -R desktop:users /home/desktop/.pki
        printf 'CORE_SECRET=%s\n' "$(openssl rand -hex 32)" > /run/pelican/zipline.env
        install -d -m 0700 -o desktop -g users /home/desktop/vesktop /home/desktop/vesktop/settings
        printf '%s\n' '{"firstLaunch":false}' > /home/desktop/vesktop/state.json
        printf '%s\n' '{"discordBranch":"stable","arRPC":false,"minimizeToTray":false,"tray":false,"hardwareAcceleration":false}' > /home/desktop/vesktop/settings.json
        printf '%s\n' '{"autoUpdate":false,"autoUpdateNotification":false,"plugins":{"Pelican":{"enabled":false}}}' > /home/desktop/vesktop/settings/settings.json
        chown -R desktop:users /home/desktop/vesktop
      '';
    };
    systemd.services.pelican-zipline = {
      wantedBy = [ "multi-user.target" ];
      requires = [ "pelican-certificates.service" ];
      after = [ "pelican-certificates.service" ];
      environment = {
        DATABASE_URL = "pglite:///var/lib/pelican-zipline/db";
        CORE_HOSTNAME = "127.0.0.1";
        CORE_PORT = "3002";
        CORE_TEMP_DIRECTORY = "/var/lib/pelican-zipline/tmp";
        CORE_RETURN_HTTPS_URLS = "true";
        DATASOURCE_TYPE = "local";
        DATASOURCE_LOCAL_DIRECTORY = "/var/lib/pelican-zipline/uploads";
        FEATURES_VERSION_CHECKING = "false";
        FEATURES_THUMBNAILS_ENABLED = "false";
        FEATURES_IMAGE_COMPRESSION = "false";
      };
      serviceConfig = {
        User = "zipline";
        Group = "zipline";
        EnvironmentFile = "/run/pelican/zipline.env";
        ExecStart = "${zipline}/bin/zipline";
        TimeoutStopSec = 15;
      };
    };
    systemd.services.pelican-proxy = {
      wantedBy = [ "multi-user.target" ];
      requires = [ "pelican-certificates.service" ];
      after = [ "pelican-certificates.service" ];
      serviceConfig = {
        ExecStart = "${node} ${proxy}";
        TimeoutStopSec = 5;
      };
    };
    # Started by the driver only after the isolated backend and USER token exist.
    systemd.services.pelican-vesktop = {
      requires = [ "pelican-proxy.service" ];
      after = [
        "display-manager.service"
        "pelican-proxy.service"
      ];
      environment = {
        DISPLAY = ":0";
        XAUTHORITY = "/home/desktop/.Xauthority";
        HOME = "/home/desktop";
        XDG_RUNTIME_DIR = "/run/user/1000";
        VENCORD_USER_DATA_DIR = "/home/desktop/vesktop";
        NODE_EXTRA_CA_CERTS = "/run/pelican/ca.crt";
        LIBGL_ALWAYS_SOFTWARE = "1";
      };
      serviceConfig = {
        User = "desktop";
        Group = "users";
        ExecStart = "${vesktop}/bin/vesktop --disable-gpu --ozone-platform=x11 --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222";
        TimeoutStopSec = 15;
        # Let Electron exit before terminating its GPU/zygote subprocesses.
        KillMode = "mixed";
      };
    };
  };
  testScript = ''
    import json

    start_all()
    try:
        machine.wait_for_unit("pelican-certificates.service")
        machine.wait_for_unit("pelican-zipline.service")
        machine.wait_for_unit("pelican-proxy.service")
        machine.wait_for_x()
        machine.wait_until_succeeds("curl --fail --silent --cacert /run/pelican/ca.crt https://shares.example.test/api/setup", timeout=180)
        machine.succeed("curl --fail --silent --cacert /run/pelican/ca.crt https://discord.com/channels/@me >/dev/null")
        machine.fail("curl --connect-timeout 3 --max-time 5 --silent https://1.1.1.1")
        machine.succeed("NODE_EXTRA_CA_CERTS=/run/pelican/ca.crt ${node} ${seed}")
        machine.succeed("test $(stat -c %a /run/pelican/token) = 400; test $(stat -c %U /run/pelican/token) = desktop")
        machine.succeed("systemctl start pelican-vesktop")
        machine.wait_until_succeeds("curl --fail --silent http://127.0.0.1:9222/json/list", timeout=120)
        machine.succeed("NODE_EXTRA_CA_CERTS=/run/pelican/ca.crt ${fixture}/bin/pelican-ui-test --phase configure --cdp http://127.0.0.1:9222 --control http://127.0.0.1:3003 --token-file /run/pelican/token --artifacts /tmp/pelican-artifacts > /tmp/pelican-artifacts/configure.log 2>&1", timeout=180)
        # Restart the entire application, not just the renderer, to prove that
        # ordinary Vencord settings were persisted by the real native bridge.
        machine.succeed("systemctl restart pelican-vesktop")
        machine.wait_until_succeeds("curl --fail --silent http://127.0.0.1:9222/json/list", timeout=120)
        machine.succeed("NODE_EXTRA_CA_CERTS=/run/pelican/ca.crt ${fixture}/bin/pelican-ui-test --phase run --cdp http://127.0.0.1:9222 --control http://127.0.0.1:3003 --token-file /run/pelican/token --artifacts /tmp/pelican-artifacts > /tmp/pelican-artifacts/driver.log 2>&1", timeout=900)
        machine.succeed("NODE_EXTRA_CA_CERTS=/run/pelican/ca.crt ${node} ${ownership}")
        result = json.loads(machine.succeed("cat /tmp/pelican-artifacts/result.json"))
        assert result["ok"], result
        assert result["downloads"], result
        machine.screenshot("pelican-desktop-success")
    finally:
        # Preserve diagnostics even when readiness, TLS, renderer, or upload fails.
        machine.execute("mkdir -p /tmp/pelican-artifacts; journalctl --no-pager -u pelican-vesktop -u pelican-zipline -u pelican-proxy -u pelican-certificates > /tmp/pelican-artifacts/services.log")
        machine.execute("curl --silent http://127.0.0.1:3003/state > /tmp/pelican-artifacts/network.json; nft list ruleset > /tmp/pelican-artifacts/firewall.txt")
        try:
            machine.screenshot("pelican-desktop-final")
        finally:
            try:
                machine.copy_from_machine("/tmp/pelican-artifacts", "pelican-artifacts")
            finally:
                machine.execute("systemctl stop pelican-vesktop pelican-proxy pelican-zipline")
  '';
}
