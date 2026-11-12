{
  description = "Pi coding agent";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # nixpkgs unstable no longer supports Intel macOS. Keep using the final
    # Darwin branch that does so for pi's x86_64-darwin package.
    nixpkgs-darwin-x64.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-darwin-x64,
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      nixpkgsFor = system: if system == "x86_64-darwin" then nixpkgs-darwin-x64 else nixpkgs;
      pkgsFor = system: import (nixpkgsFor system) { inherit system; };
      packageFor = system: (pkgsFor system).callPackage ./nix/package.nix { source = self; };
    in
    {
      packages = forAllSystems (system: {
        default = packageFor system;
        pi = packageFor system;
      });

      # Tools ./test.sh needs besides Node, for hosts that lack them (NixOS): fd and ripgrep for the
      # find/grep tool tests, cargo and rustc for the pi-env daemon build, and bubblewrap for the
      # sandbox extension on Linux. Not rustup: the pi-env tests run cargo from packages/env, above
      # daemon/rust-toolchain.toml, so rustup finds no pin there and needs a default toolchain, as CI
      # runners have. Usage: `nix develop -c ./test.sh`.
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.fd
              pkgs.ripgrep
              pkgs.cargo
              pkgs.rustc
            ]
            ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.bubblewrap ];
          };
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/pi";
          meta.description = "Pi coding agent";
        };
        pi = self.apps.${system}.default;
      });

      overlays.default = final: _previous: {
        pi = final.callPackage ./nix/package.nix { source = self; };
      };
    };
}
