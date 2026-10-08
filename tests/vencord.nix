{
  vencord,
  fetchurl,
  applyPatches,
  pluginSource,
}:
vencord.overrideAttrs (oldAttrs: {
  # Discord removed the named modal exports used by Vencord 1.15.1.
  # Backport upstream's shared fix; Pelican must not replace the settings UI.
  src =
    if oldAttrs.version != "1.15.1" then
      oldAttrs.src
    else
      (applyPatches {
        name = "vencord-modal-compatible-source";
        inherit (oldAttrs) src;
        patches = [
          (fetchurl {
            url = "https://github.com/Vendicated/Vencord/commit/90aea0ddbbfbee16ce052b2c7ab610ffe957b4ca.patch";
            hash = "sha256-fldDGIClghkJdOD1FbiKvxTCK1qqKMq5zDNcVvC1Ilk=";
          })
        ];
      })
      // {
        # nixpkgs derives VENCORD_REMOTE from the source's GitHub metadata.
        inherit (oldAttrs.src) owner repo;
      };
  # Vencord compiles desktop userplugins and their native helpers together.
  preBuild = (oldAttrs.preBuild or "") + ''
    mkdir -p src/userplugins/pelican.desktop
    cp ${pluginSource}/* src/userplugins/pelican.desktop/
  '';
})
