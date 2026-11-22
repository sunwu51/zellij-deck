# Bundled terminal symbols

Zellij Deck bundles the unmodified **Symbols Nerd Font Mono Regular** from Nerd Fonts **v3.4.0** as a private-use Unicode symbol fallback. Ordinary terminal text continues to use the platform's configured font stack.

Source: https://github.com/ryanoasis/nerd-fonts/tree/v3.4.0/patched-fonts/NerdFontsSymbolsOnly

File: `nerd-fonts-v3.4.0/SymbolsNerdFontMono-Regular.ttf`

Copyright (c) 2014 Ryan L McIntyre. Distributed under the MIT license included at `nerd-fonts-v3.4.0/LICENSE`. The upstream README is included in the same directory. The build copies this entire directory, including attribution and license, into the extension.

The CSS family is limited to private-use Unicode ranges to supply Powerline separators and Nerd Font icons without replacing ASCII text or changing ordinary terminal text metrics. The font is loaded from the extension itself before xterm initialization; no remote font request or operating-system font installation is required.
