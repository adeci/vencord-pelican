{
  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      pluginSource = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions [
          ./index.tsx
          ./native.ts
          ./attachmentFlow.ts
          ./settings.tsx
          ./types.ts
        ];
      };
      vencord = pkgs.callPackage ./tests/vencord.nix { inherit pluginSource; };
      vesktop =
        (pkgs.vesktop.override {
          inherit vencord;
          withSystemVencord = true;
        }).overrideAttrs
          (oldAttrs: {
            postPatch = (oldAttrs.postPatch or "") + ''
              substituteInPlace src/main/vencordFilesDir.ts \
                --replace-fail 'State.store.vencordDir || ' ""
            '';
          });
      fixture = import ./tests/desktop {
        inherit pkgs pluginSource vencord;
      };
      zipline = pkgs.callPackage ./tests/zipline.nix { };
    in
    {
      inherit pluginSource;
      checks.${system} = {
        inherit vencord;
        desktop = import ./tests/vm.nix {
          inherit
            pkgs
            vesktop
            fixture
            zipline
            ;
        };
        native =
          pkgs.runCommand "pelican-native-check"
            {
              nativeBuildInputs = [ pkgs.nodejs_24 ];
            }
            ''
              node ${./tests}/native.mjs ${pluginSource}
              touch "$out"
            '';
      };
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_24
          pkgs.pnpm_11
          pkgs.nixfmt
        ];
      };
      formatter.${system} = pkgs.nixfmt-tree.override {
        settings.tree-root-file = "flake.nix";
      };
    };
}
