# vencord-pelican

Desktop Vencord plugin for sharing oversized files through your own [Zipline](https://github.com/diced/zipline) server.
(Assuming you have your own Zipline server and bucket to use).

## Why

File too big to upload? Fine, I'll do it myself. Never get pissed off again trying to share a video or something on Discord.

## Install

Requires desktop Vencord/Vesktop and an HTTPS Zipline (tested and built for v4.8) server.

### Without Nix

Start with a [Vencord source checkout](https://docs.vencord.dev/installing/). From its root:

```sh
mkdir -p src/userplugins
git clone https://github.com/adeci/vencord-pelican src/userplugins/pelican.desktop
pnpm build
```

Install that custom Vencord build (`pnpm inject` for Discord; select the built Vencord directory in Vesktop settings), then fully quit and reopen the client. To update, pull inside `src/userplugins/pelican.desktop` and rebuild Vencord.

### With Nix

**With flakes:** add `inputs.pelican.url = "github:adeci/vencord-pelican";` to your flake. Pelican exports `pluginSource`.

**Vencord only:** this returns a Vencord build with Pelican included.

```nix
let
  pelicanSource = inputs.pelican.pluginSource;
  vencord = pkgs.vencord.overrideAttrs (old: {
    preBuild = (old.preBuild or "") + "\n" + ''
      mkdir -p src/userplugins
      cp -r ${pelicanSource} src/userplugins/pelican.desktop
    '';
  });
in
vencord
```

**Without flakes:** Nix can fetch the source directly—no manual clone needed. Replace the `pelicanSource` binding above with:

```nix
  pelicanSource = builtins.fetchTarball {
    url = "https://github.com/adeci/vencord-pelican/archive/main.tar.gz";
  };
```

**Vesktop with Pelican (either source option):** keep the same `let` block, but replace `in vencord` with:

```nix
in
pkgs.vesktop.override {
  inherit vencord;
  withSystemVencord = true;
}
```

The first option produces Vencord's built files, not to be confused with an installed Discord client. The second produces a Vesktop package you can install normally. Add other plugins to the same Vencord build.

## Use

Enable **Pelican** in Vencord settings, enter your server URL and a non-admin API token, then attach a file. The token is stored unencrypted in Vencord settings.

Shared links are public to anyone who has them. Discord embeds/playback depend on the file and client (image and video embeds work).
