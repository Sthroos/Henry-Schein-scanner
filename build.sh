#!/bin/bash

# Henry Schein Barcode Bestellen - Build Script
#
# GEBRUIK:
#   ./build.sh              # bouwt beide targets
#   ./build.sh chrome       # alleen Chrome/Edge
#   ./build.sh firefox      # alleen Firefox
#
# OUTPUT:
#   dist/chrome/    → "Uitgepakte extensie laden" in chrome://extensions (Chrome/Edge)
#                     later ook: input voor Chrome Web Store / Edge Add-ons upload
#   dist/firefox/   → "Tijdelijke add-on laden" in about:debugging (Firefox 151+)
#                     later ook: input voor `web-ext sign --channel=listed` (AMO)
#
# Er is nu maar één versie per browser (geen apart dev/unlisted/listed-onderscheid):
# deze extensie draait nog niet naast een gepubliceerde versie, dus is er geen reden
# om ID's of namen te laten verschillen tussen lokaal testen en een latere publicatie.
# Zodra er wél een publieke listing is, wordt dat hier pas relevant.

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

TARGET=${1:-"all"}
BUILD_DIR="dist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

VALID_TARGETS=("all" "chrome" "firefox")
if [[ ! " ${VALID_TARGETS[@]} " =~ " $TARGET " ]]; then
    echo -e "${RED}Onbekend target: $TARGET${NC}"
    echo "Gebruik: ./build.sh [all|chrome|firefox]"
    exit 1
fi

echo -e "${YELLOW}╔════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║  Henry Schein Barcode Bestellen — Build ║${NC}"
echo -e "${YELLOW}╚════════════════════════════════════════╝${NC}"
echo ""

# Patch-versie automatisch ophogen bij elke build, in chrome/ en firefox/manifest.json
# gelijk gehouden. Het versienummer staat ook rechtsonder in het overlay, zodat je aan
# het getal kunt zien of je een oude of de nieuwste build
# hebt geladen — in plaats van daarop te moeten gokken.
bump_version() {
    local CURRENT MAJOR MINOR PATCH NEXT
    CURRENT=$(grep -m1 '"version"' chrome/manifest.json | sed -E 's/.*"version": *"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')
    IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
    NEXT="$MAJOR.$MINOR.$((PATCH + 1))"
    sed -i -E "s/\"version\": *\"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"$NEXT\"/" chrome/manifest.json firefox/manifest.json
    echo -e "${GREEN}►${NC} versie: $CURRENT → $NEXT"
}
bump_version
echo ""

copy_shared() {
    local OUT=$1
    rm -rf "$OUT"
    mkdir -p "$OUT"
    cp shared/background.js    "$OUT/"
    cp shared/content-panel.js  "$OUT/"
    cp shared/content-panel.css "$OUT/"
    cp shared/icon-*.png       "$OUT/"
}

build_chrome() {
    echo -e "${GREEN}► chrome${NC}  (lokaal laden nu; Chrome Web Store + Edge later)"
    local OUT="$BUILD_DIR/chrome"
    copy_shared "$OUT"
    cp chrome/manifest.json "$OUT/"
    echo -e "  ${GREEN}✓${NC} $OUT/"
}

build_firefox() {
    echo -e "${GREEN}► firefox${NC}  (lokaal laden nu; AMO listed later)"
    local OUT="$BUILD_DIR/firefox"
    copy_shared "$OUT"
    cp firefox/manifest.json "$OUT/"
    echo -e "  ${GREEN}✓${NC} $OUT/"

    # about:debugging → "Tijdelijke add-on laden" accepteert zowel manifest.json binnen de
    # map als een kant-en-klare .zip; de zip is hier het robuustere pad omdat de bestandkiezer
    # soms de map zelf laat selecteren in plaats van het manifest.json-bestand erin.
    local ZIP="$BUILD_DIR/firefox.zip"
    rm -f "$ZIP"
    (cd "$OUT" && zip -r "$SCRIPT_DIR/$ZIP" . -x "*.DS_Store" > /dev/null)
    echo -e "  ${GREEN}✓${NC} $ZIP  ← alternatief: sleep dit bestand naar about:debugging"
}

mkdir -p "$BUILD_DIR"

case "$TARGET" in
    chrome)  build_chrome ;;
    firefox) build_firefox ;;
    all)
        build_chrome
        build_firefox
        ;;
esac

echo ""
echo -e "${GREEN}✓ Build klaar!${NC}"
echo ""
[[ "$TARGET" == "all" || "$TARGET" == "chrome"  ]] && echo -e "  ${GREEN}Chrome/Edge:${NC}  chrome://extensions → Uitgepakte extensie laden → dist/chrome"
[[ "$TARGET" == "all" || "$TARGET" == "firefox" ]] && echo -e "  ${GREEN}Firefox:${NC}      about:debugging#/runtime/this-firefox → Tijdelijke add-on laden → dist/firefox/manifest.json óf dist/firefox.zip"
echo ""
exit 0
