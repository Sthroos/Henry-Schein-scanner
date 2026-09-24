#!/bin/bash

# Henry Schein Barcode Bestellen - Release Script
#
# Gebruik: ./release.sh <versie> [release notes]
# Voorbeeld: ./release.sh 1.0.1 "Wake-retry fix voor OPN-2001"
#
# Wat dit script doet:
#   0. Sync met GitHub + versie bijwerken + bouwen
#   1. Chrome/Edge: automatisch publiceren via API — ALLEEN als er credentials in .env staan
#   2. Firefox: blijft altijd handmatig — upload dist/firefox (gezipt) zelf op
#      https://addons.mozilla.org/developers/ zodra je een publieke listing hebt
#   3. Commit + push naar GitHub
#
# Zolang er geen .env met Chrome/Edge-credentials is, doet dit script alleen stap 0 en 3 —
# dus lokaal bouwen + naar GitHub pushen. Dat is de huidige stand: nog geen publieke listing.
#
# VEREISTE .env variabelen (pas relevant zodra je publiceert):
#   EDGE_CLIENT_ID         Microsoft Partner Center Client ID
#   EDGE_API_KEY           Microsoft Partner Center API key (verloopt na ~90 dagen)
#   EDGE_PRODUCT_ID        Microsoft Edge product ID (GUID) — ontstaat pas na eerste handmatige submission
#   CHROME_CLIENT_ID       Google OAuth2 Client ID
#   CHROME_CLIENT_SECRET   Google OAuth2 Client Secret
#   CHROME_REFRESH_TOKEN   Google OAuth2 Refresh token
#   CHROME_PUBLISHER_ID    Chrome Web Store publisher ID
#   CHROME_EXTENSION_ID    Chrome extension ID — ontstaat pas na eerste handmatige submission
#
# Zie STORE_LISTING.md voor de teksten die je bij die eerste handmatige submission nodig hebt.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

WARNINGS_FILE=$(mktemp)
warn() { echo -e "${YELLOW}⚠${NC} $1"; echo "$1" >> "$WARNINGS_FILE"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Edge: credentials valideren ─────────────────────────────────────────────
edge_check_credentials() {
    local PRODUCT_ID=$1 CLIENT_ID=$2 API_KEY=$3
    local BASE="https://api.addons.microsoftedge.microsoft.com"
    CHECK_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: ApiKey $API_KEY" -H "X-ClientID: $CLIENT_ID" \
        "$BASE/v1/products/$PRODUCT_ID/submissions/draft/package/operations/health-check" \
        2>/dev/null || echo "000")
    case "$CHECK_STATUS" in
        200|404) echo -e "  ${GREEN}✓${NC} Edge credentials geldig"; return 0 ;;
        401|403) echo -e "  ${RED}✗ Edge API key verlopen of ongeldig (HTTP $CHECK_STATUS)${NC}"; return 1 ;;
        000)     echo -e "  ${YELLOW}⚠${NC} Geen verbinding met Edge API"; return 1 ;;
        *)       echo -e "  ${YELLOW}⚠${NC} Onverwachte status $CHECK_STATUS — gaan toch door"; return 0 ;;
    esac
}

# ─── Edge: uploaden + publiceren ─────────────────────────────────────────────
edge_api_upload() {
    local ZIP=$1 PRODUCT_ID=$2 CLIENT_ID=$3 API_KEY=$4
    local BASE="https://api.addons.microsoftedge.microsoft.com"

    echo -e "  [Edge] Uploaden..."
    UPLOAD_RESPONSE=$(curl -s -i \
        -H "Authorization: ApiKey $API_KEY" -H "X-ClientID: $CLIENT_ID" \
        -H "Content-Type: application/zip" -X POST -T "$ZIP" \
        "$BASE/v1/products/$PRODUCT_ID/submissions/draft/package")
    HTTP_STATUS=$(echo "$UPLOAD_RESPONSE" | grep -i "^HTTP/" | tail -1 | awk '{print $2}')
    OPERATION_ID=$(echo "$UPLOAD_RESPONSE" | grep -i "^Location:" | awk '{print $2}' | tr -d '\r')
    if [ "$HTTP_STATUS" != "202" ]; then
        echo -e "  ${RED}[Edge] Upload mislukt (HTTP $HTTP_STATUS)${NC}"; echo "$UPLOAD_RESPONSE" | tail -5; return 1
    fi
    echo -e "  ${GREEN}[Edge]${NC} Upload geaccepteerd"

    local ATTEMPTS=0
    while [ $ATTEMPTS -lt 20 ]; do
        sleep 5
        STATUS=$(curl -s -H "Authorization: ApiKey $API_KEY" -H "X-ClientID: $CLIENT_ID" \
            "$BASE/v1/products/$PRODUCT_ID/submissions/draft/package/operations/$OPERATION_ID" \
            | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
        [ "$STATUS" = "Succeeded" ] && { echo -e "  ${GREEN}[Edge]${NC} Pakket verwerkt"; break; }
        [ "$STATUS" = "Failed"    ] && { echo -e "  ${RED}[Edge] Pakketverwerking mislukt${NC}"; return 1; }
        ATTEMPTS=$((ATTEMPTS+1))
        echo -e "  [Edge] ⏳ ${STATUS:-InProgress} (poging $ATTEMPTS/20)..."
    done
    [ $ATTEMPTS -ge 20 ] && { warn "Edge upload polling timeout"; return 1; }

    echo -e "  [Edge] Publiceren..."
    PUBLISH_RESPONSE=$(curl -s -i \
        -H "Authorization: ApiKey $API_KEY" -H "X-ClientID: $CLIENT_ID" \
        -H "Content-Type: application/json" -X POST \
        -d "{\"notes\":\"Release $NEW_VERSION - $RELEASE_NOTES\"}" \
        "$BASE/v1/products/$PRODUCT_ID/submissions")
    PUB_HTTP=$(echo "$PUBLISH_RESPONSE" | grep -i "^HTTP/" | tail -1 | awk '{print $2}')
    PUB_OP=$(echo "$PUBLISH_RESPONSE" | grep -i "^Location:" | awk '{print $2}' | tr -d '\r')
    if [ "$PUB_HTTP" != "202" ]; then
        echo -e "  ${RED}[Edge] Publiceren mislukt (HTTP $PUB_HTTP)${NC}"; echo "$PUBLISH_RESPONSE" | tail -5; return 1
    fi
    echo -e "  ${GREEN}[Edge]${NC} Publiceren gestart"

    ATTEMPTS=0
    while [ $ATTEMPTS -lt 20 ]; do
        sleep 5
        PUB_RESPONSE=$(curl -s -H "Authorization: ApiKey $API_KEY" -H "X-ClientID: $CLIENT_ID" \
            "$BASE/v1/products/$PRODUCT_ID/submissions/operations/$PUB_OP")
        PUB_VAL=$(echo "$PUB_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
        ERR=$(echo "$PUB_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('errorCode',''))" 2>/dev/null || echo "")
        if [ "$PUB_VAL" = "Succeeded" ]; then echo -e "  ${GREEN}[Edge]${NC} Gepubliceerd ✓"; return 0; fi
        if [ "$PUB_VAL" = "Failed" ]; then
            case "$ERR" in
                InProgressSubmission) echo -e "  ${YELLOW}[Edge]${NC} Submission al in review — draft bijgewerkt ✓"; return 2 ;;
                NoModulesUpdated)     echo -e "  ${YELLOW}[Edge]${NC} Geen wijzigingen gedetecteerd"; return 1 ;;
                *) echo -e "  ${RED}[Edge] Mislukt (errorCode: ${ERR:-onbekend})${NC}"; echo "$PUB_RESPONSE"; return 1 ;;
            esac
        fi
        ATTEMPTS=$((ATTEMPTS+1))
        echo -e "  [Edge] ⏳ ${PUB_VAL:-InProgress} (poging $ATTEMPTS/20)..."
    done
    warn "Edge publish polling timeout"; return 0
}

# ─── Chrome: access token ophalen ────────────────────────────────────────────
chrome_get_token() {
    curl -s -X POST "https://oauth2.googleapis.com/token" \
        -d "client_id=$1" -d "client_secret=$2" -d "refresh_token=$3" -d "grant_type=refresh_token" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo ""
}

# ─── Chrome: credentials valideren ───────────────────────────────────────────
chrome_check_credentials() {
    local CLIENT_ID=$1 CLIENT_SECRET=$2 REFRESH_TOKEN=$3 PUBLISHER_ID=$4 EXTENSION_ID=$5
    echo -e "  Access token ophalen..."
    ACCESS_TOKEN=$(chrome_get_token "$CLIENT_ID" "$CLIENT_SECRET" "$REFRESH_TOKEN")
    if [ -z "$ACCESS_TOKEN" ]; then
        echo -e "  ${RED}✗ Kon geen access token ophalen${NC}"; return 1
    fi
    STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        "https://chromewebstore.googleapis.com/v2/publishers/$PUBLISHER_ID/items/$EXTENSION_ID:fetchStatus")
    case "$STATUS_CODE" in
        200) echo -e "  ${GREEN}✓${NC} Chrome credentials geldig"; CHROME_ACCESS_TOKEN="$ACCESS_TOKEN"; return 0 ;;
        401|403) echo -e "  ${RED}✗ Chrome credentials ongeldig (HTTP $STATUS_CODE)${NC}"; return 1 ;;
        404) echo -e "  ${RED}✗ Publisher/Extension ID niet gevonden (HTTP 404)${NC}"; return 1 ;;
        *) echo -e "  ${YELLOW}⚠${NC} Status $STATUS_CODE — gaan toch door"; CHROME_ACCESS_TOKEN="$ACCESS_TOKEN"; return 0 ;;
    esac
}

# ─── Chrome: uploaden + publiceren ───────────────────────────────────────────
chrome_api_upload() {
    local ZIP=$1 PUBLISHER_ID=$2 EXTENSION_ID=$3 ACCESS_TOKEN=$4
    local BASE="https://chromewebstore.googleapis.com"

    echo -e "  [Chrome] Status controleren..."
    UPLOAD_STATE=$(curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
        "$BASE/v2/publishers/$PUBLISHER_ID/items/$EXTENSION_ID:fetchStatus" \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('itemState',{}).get('uploadState',''))" 2>/dev/null || echo "")
    if [ "$UPLOAD_STATE" = "UPLOAD_IN_PROGRESS" ]; then
        echo -e "  ${YELLOW}[Chrome]${NC} Lopende submission annuleren..."
        CANCEL=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ACCESS_TOKEN" \
            -X POST "$BASE/v2/publishers/$PUBLISHER_ID/items/$EXTENSION_ID:cancelSubmission")
        [ "$CANCEL" = "200" ] || [ "$CANCEL" = "204" ] \
            && { echo -e "  ${GREEN}[Chrome]${NC} Geannuleerd"; sleep 3; } \
            || echo -e "  ${YELLOW}[Chrome]${NC} Annuleren mislukt (HTTP $CANCEL) — toch doorgaan"
    fi

    echo -e "  [Chrome] Uploaden..."
    UPLOAD_RESPONSE=$(curl -s -H "Authorization: Bearer $ACCESS_TOKEN" -X POST -T "$ZIP" \
        "$BASE/upload/v2/publishers/$PUBLISHER_ID/items/$EXTENSION_ID:upload")
    if echo "$UPLOAD_RESPONSE" | grep -qi '"error"'; then
        MSG=$(echo "$UPLOAD_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error',{}).get('message','onbekend'))" 2>/dev/null || echo "onbekend")
        echo -e "  ${RED}[Chrome] Upload mislukt: $MSG${NC}"; return 1
    fi
    echo -e "  ${GREEN}[Chrome]${NC} Upload geslaagd"

    echo -e "  [Chrome] Publiceren..."
    PUBLISH_RESPONSE=$(curl -s -H "Authorization: Bearer $ACCESS_TOKEN" -X POST \
        "$BASE/v2/publishers/$PUBLISHER_ID/items/$EXTENSION_ID:publish")
    if echo "$PUBLISH_RESPONSE" | grep -qi '"error"'; then
        echo -e "  ${RED}[Chrome] Publiceren mislukt${NC}"; echo "$PUBLISH_RESPONSE"; return 1
    fi
    echo -e "  ${GREEN}[Chrome]${NC} Gepubliceerd ✓ (staat in review bij Google)"; return 0
}

# ─── Credentials laden ───────────────────────────────────────────────────────
if [ -f "$SCRIPT_DIR/.env" ]; then
    echo -e "${GREEN}✓${NC} Credentials geladen uit .env"
    source "$SCRIPT_DIR/.env"
fi

if [ -z "$1" ]; then
    echo -e "${RED}Fout: versienummer vereist${NC}"
    echo "Gebruik: ./release.sh <versie> [release notes]"
    exit 1
fi

# Debug-schakelaars mogen nooit in een release belanden: DEBUG_FAKE_SCAN_CODES zet
# nep-artikelen in de wachtrij (die met één klik écht in het mandje gaan), en
# DEBUG_SKIP_SCANNER_CLEAR laat oude scans op de scanner staan.
PANEL_JS="$SCRIPT_DIR/shared/content-panel.js"
if grep -q "^const DEBUG_SKIP_SCANNER_CLEAR = true;" "$PANEL_JS" \
   || ! grep -q "^const DEBUG_FAKE_SCAN_CODES = \[\];" "$PANEL_JS"; then
    echo -e "${RED}Fout: debug-schakelaars staan nog aan in shared/content-panel.js.${NC}"
    echo "Zet DEBUG_SKIP_SCANNER_CLEAR = false en DEBUG_FAKE_SCAN_CODES = [] vóór een release."
    exit 1
fi

NEW_VERSION=$1
RELEASE_NOTES=${2:-"Release $NEW_VERSION"}
CURRENT_VERSION=$(grep -Po '"version":\s*"\K[^"]+' "$SCRIPT_DIR/chrome/manifest.json")

EDGE_OK=true
if [ -z "$EDGE_CLIENT_ID" ] || [ -z "$EDGE_API_KEY" ] || [ -z "$EDGE_PRODUCT_ID" ]; then
    echo -e "${YELLOW}⚠${NC} Edge credentials niet gevonden — Edge publishing overgeslagen (nog geen publieke listing)"
    EDGE_OK=false
else
    echo -e "Edge credentials controleren..."
    edge_check_credentials "$EDGE_PRODUCT_ID" "$EDGE_CLIENT_ID" "$EDGE_API_KEY" || { warn "Edge credentials ongeldig"; EDGE_OK=false; }
fi

CHROME_OK=true
if [ -z "$CHROME_CLIENT_ID" ] || [ -z "$CHROME_CLIENT_SECRET" ] || [ -z "$CHROME_REFRESH_TOKEN" ] \
   || [ -z "$CHROME_PUBLISHER_ID" ] || [ -z "$CHROME_EXTENSION_ID" ]; then
    echo -e "${YELLOW}⚠${NC} Chrome credentials niet gevonden — Chrome publishing overgeslagen (nog geen publieke listing)"
    CHROME_OK=false
else
    echo -e "Chrome credentials controleren..."
    chrome_check_credentials "$CHROME_CLIENT_ID" "$CHROME_CLIENT_SECRET" "$CHROME_REFRESH_TOKEN" \
        "$CHROME_PUBLISHER_ID" "$CHROME_EXTENSION_ID" || { warn "Chrome credentials ongeldig"; CHROME_OK=false; }
fi

echo ""
echo -e "${YELLOW}╔════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║  Henry Schein Barcode Bestellen Release ║${NC}"
echo -e "${YELLOW}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "Vorige versie:   ${YELLOW}$CURRENT_VERSION${NC}"
echo -e "Nieuwe versie:   ${GREEN}$NEW_VERSION${NC}"
echo -e "Release notes:   $RELEASE_NOTES"
echo ""
echo -e "Dit script doet:"
if [ "$EDGE_OK" = true ]; then echo -e "  ${GREEN}Edge Add-ons${NC}      → automatisch via API"; else echo -e "  ${YELLOW}Edge Add-ons${NC}      → OVERGESLAGEN"; fi
if [ "$CHROME_OK" = true ]; then echo -e "  ${GREEN}Chrome Web Store${NC}  → automatisch via API"; else echo -e "  ${YELLOW}Chrome Web Store${NC}  → OVERGESLAGEN"; fi
echo -e "  ${YELLOW}Firefox${NC}           → altijd handmatig (dist/firefox zippen, zelf uploaden op AMO)"
echo -e "  Bouwen + committen + pushen naar GitHub"
echo ""

read -p "Doorgaan met release? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Release geannuleerd"; rm -f "$WARNINGS_FILE"; exit 1
fi

cd "$SCRIPT_DIR"

# ─── Stap 0: Git sync (standalone repo, geen submap-nesting) ─────────────────
echo ""
echo -e "${GREEN}[0/3]${NC} Synchroniseren met GitHub..."
git stash
git pull origin main --rebase
git stash pop 2>/dev/null || true
echo -e "${GREEN}✓${NC} Gesynchroniseerd"

# ─── Stap 1: Versie bijwerken + bouwen ───────────────────────────────────────
echo ""
echo -e "${GREEN}[1/3]${NC} Versie bijwerken en bouwen..."

update_version() {
    local FILE=$1
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" "$FILE"
    else
        sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" "$FILE"
    fi
}
update_version "$SCRIPT_DIR/chrome/manifest.json"
update_version "$SCRIPT_DIR/firefox/manifest.json"
echo -e "${GREEN}✓${NC} Versie $NEW_VERSION ingesteld"

"$SCRIPT_DIR/build.sh" all
echo -e "${GREEN}✓${NC} Build klaar"

(cd "$SCRIPT_DIR/dist/chrome" && zip -r "$SCRIPT_DIR/HenrySchein-Scanner-Chrome.zip" . -x "*.DS_Store" > /dev/null)
(cd "$SCRIPT_DIR/dist/firefox" && zip -r "$SCRIPT_DIR/HenrySchein-Scanner-Firefox.zip" . -x "*.DS_Store" > /dev/null)
echo -e "${GREEN}✓${NC} HenrySchein-Scanner-Chrome.zip en HenrySchein-Scanner-Firefox.zip klaar"

# ─── Stap 2: Chrome/Edge publiceren (parallel, alleen als credentials aanwezig) ──
echo ""
echo -e "${GREEN}[2/3]${NC} Chrome/Edge publiceren..."
echo ""

EDGE_RESULT_FILE=$(mktemp)
CHROME_RESULT_FILE=$(mktemp)

(
    if [ "$EDGE_OK" = true ]; then
        edge_api_upload "$SCRIPT_DIR/HenrySchein-Scanner-Chrome.zip" "$EDGE_PRODUCT_ID" "$EDGE_CLIENT_ID" "$EDGE_API_KEY" || true
        echo $? > "$EDGE_RESULT_FILE"
    else
        echo 99 > "$EDGE_RESULT_FILE"
    fi
) &
PID_EDGE=$!

(
    if [ "$CHROME_OK" = true ]; then
        FRESH_TOKEN=$(chrome_get_token "$CHROME_CLIENT_ID" "$CHROME_CLIENT_SECRET" "$CHROME_REFRESH_TOKEN")
        if [ -z "$FRESH_TOKEN" ]; then
            echo -e "  ${YELLOW}[Chrome]${NC} Kon geen access token ophalen"; echo 1 > "$CHROME_RESULT_FILE"
        else
            chrome_api_upload "$SCRIPT_DIR/HenrySchein-Scanner-Chrome.zip" "$CHROME_PUBLISHER_ID" "$CHROME_EXTENSION_ID" "$FRESH_TOKEN" || true
            echo $? > "$CHROME_RESULT_FILE"
        fi
    else
        echo 99 > "$CHROME_RESULT_FILE"
    fi
) &
PID_CHROME=$!

wait $PID_EDGE
wait $PID_CHROME
EDGE_CODE=$(cat "$EDGE_RESULT_FILE" 2>/dev/null || echo "1")
CHROME_CODE=$(cat "$CHROME_RESULT_FILE" 2>/dev/null || echo "1")
rm -f "$EDGE_RESULT_FILE" "$CHROME_RESULT_FILE"

# ─── Stap 3: GitHub push (standalone repo root) ──────────────────────────────
echo ""
echo -e "${GREEN}[3/3]${NC} Pushen naar GitHub..."

for IGNORE_ENTRY in "dist/" "*.zip" ".env"; do
    if [ ! -f "$SCRIPT_DIR/.gitignore" ] || ! grep -qxF "$IGNORE_ENTRY" "$SCRIPT_DIR/.gitignore" 2>/dev/null; then
        echo "$IGNORE_ENTRY" >> "$SCRIPT_DIR/.gitignore"
    fi
done

git add .
git commit -m "Release v$NEW_VERSION - $RELEASE_NOTES" || true
git push origin main && echo -e "${GREEN}✓${NC} Gepusht naar GitHub" || warn "Push mislukt — controleer je GitHub rechten"

# ─── Eindrapport ─────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Release $NEW_VERSION afgerond${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "Firefox: upload handmatig zodra je een publieke listing wilt:"
echo "  https://addons.mozilla.org/developers/  → HenrySchein-Scanner-Firefox.zip"
echo ""
case "$EDGE_CODE" in
    0)  echo -e "${GREEN}Edge Add-ons:${NC}      Gepubliceerd ✓ (staat in review)" ;;
    2)  echo -e "${YELLOW}Edge Add-ons:${NC}      Draft bijgewerkt ✓ — publiceer handmatig na review" ;;
    99) echo -e "${YELLOW}Edge Add-ons:${NC}      Overgeslagen (geen credentials)" ;;
    *)  echo -e "${YELLOW}Edge Add-ons:${NC}      Mislukt of nog geen listing — upload later handmatig: HenrySchein-Scanner-Chrome.zip" ;;
esac
case "$CHROME_CODE" in
    0)  echo -e "${GREEN}Chrome Web Store:${NC}  Gepubliceerd ✓ (staat in review)" ;;
    99) echo -e "${YELLOW}Chrome Web Store:${NC}  Overgeslagen (geen credentials)" ;;
    *)  echo -e "${YELLOW}Chrome Web Store:${NC}  Mislukt of nog geen listing — upload later handmatig: HenrySchein-Scanner-Chrome.zip" ;;
esac

FINAL_WARNINGS=$(cat "$WARNINGS_FILE" 2>/dev/null)
rm -f "$WARNINGS_FILE"
if [ -n "$FINAL_WARNINGS" ]; then
    echo ""
    echo -e "${YELLOW}══ Waarschuwingen ══════════════════════════════════════${NC}"
    while IFS= read -r W; do echo -e "${YELLOW}⚠${NC} $W"; done <<< "$FINAL_WARNINGS"
fi
echo ""
