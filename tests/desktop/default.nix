{
  pkgs,
  pluginSource,
  vencord,
}:
let
  xxhash = pkgs.fetchzip {
    url = "https://registry.npmjs.org/@intrnl/xxhash64/-/xxhash64-0.1.2.tgz";
    hash = "sha256-vHIW6vYG28N3vdM3qPkCgipeXcdSn2FEDfYpYCt39bE=";
  };
  npm =
    name: version: hash:
    pkgs.fetchzip {
      url = "https://registry.npmjs.org/${name}/-/${name}-${version}.tgz";
      inherit hash;
    };
  react = npm "react" "19.2.0" "sha256-RRz7lgZloKOQ5BD/RbpFTfSy15+lkBe6WH8rSiX2rTI=";
  reactDom = npm "react-dom" "19.2.0" "sha256-8O2C3nVvif/wmpYSoeDcI5bCxfe/ZvDk0nmTJx6M2YQ=";
  scheduler = npm "scheduler" "0.27.0" "sha256-5ilWtDFoKg0SJIYR5wmKHqdMfxarOuq6mg4ieQ3eC6g=";
  discord = pkgs.fetchurl {
    url = "https://discord.com/assets/web.d3978f1210c00a8f.js";
    hash = "sha256-mryGlGJrUMQY0BoqnNuHnf8DmdHLXQavY56ohBdbfDw=";
  };
in
pkgs.runCommand "pelican-desktop-fixture"
  {
    nativeBuildInputs = [
      pkgs.nodejs_24
      pkgs.esbuild
      pkgs.makeWrapper
    ];
  }
  ''
    mkdir -p work/node_modules/@intrnl $out/share/pelican-test $out/bin
    cp ${./.}/*.mjs ${./.}/*.tsx work/
    cp -r ${pluginSource} work/plugin
    ln -s ${react} work/node_modules/react
    ln -s ${reactDom} work/node_modules/react-dom
    ln -s ${scheduler} work/node_modules/scheduler
    ln -s ${xxhash} work/node_modules/@intrnl/xxhash64
    cd work
    node extract.mjs ${discord} plugin/index.tsx factories.js
    node --preserve-symlinks modal-compat.mjs ${vencord.src} ${discord}
    node prepare-settings.mjs ${vencord.src}
    esbuild bootstrap.tsx --bundle --preserve-symlinks --platform=browser --format=iife \
      --jsx=transform --jsx-factory=VencordCreateElement --jsx-fragment=VencordFragment \
      --inject:${vencord.src}/scripts/build/inject/react.mjs \
      --define:process.env.NODE_ENV='"production"' --define:IS_REPORTER=false --define:IS_DEV=false \
      --define:IS_WEB=false --define:IS_VESKTOP=true --define:IS_DISCORD_DESKTOP=false \
      --define:VencordNative=window.fixtureNative \
      --alias:@webpack/common=./common.tsx --alias:@webpack=./common.tsx \
      --alias:@api/ChatButtons=./common.tsx --alias:@api/Commands=./common.tsx \
      --alias:@utils/misc=./common.tsx --alias:~plugins=./registry.mjs \
      --alias:@utils/discord=./common.tsx \
      --alias:@api=./upstream/api --alias:@utils=./upstream/utils \
      --alias:@shared=./upstream/shared --alias:@components=./upstream/components \
      --outfile=$out/share/pelican-test/fixture.js
    cp ${./index.html} $out/share/pelican-test/index.html
    cp driver.mjs $out/share/pelican-test/driver.mjs
    cp factories.js $out/share/pelican-test/factories.js
    makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/pelican-ui-test \
      --add-flags $out/share/pelican-test/driver.mjs
  ''
