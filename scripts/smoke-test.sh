#!/bin/bash
# Smoke test: runs the whole demo storyline through the portal API (requires the stack to be up).
# Usage: ./scripts/smoke-test.sh
set -u
J=$(mktemp -d); trap 'rm -rf $J' EXIT
B=${B:-http://localhost:3000}
login(){ curl -s -c $J/$1.jar -H 'content-type: application/json' -X POST $B/api/login -d "{\"username\":\"$1\",\"password\":\"$1\"}" >/dev/null; }
api(){ local u=$1; shift; curl -s -b $J/$u.jar -H 'content-type: application/json' "$@"; echo; }
firsttask(){ api $1 $B/api/tasks | python3 -c "import sys,json;t=json.load(sys.stdin);print(t[0]['key'] if t else '')"; }
for u in marco clara elena fabio; do login $u; done
echo "== 1. marco submits"; api marco -X POST $B/api/requests -d '{"eventTitle":"Advances in Heart Failure Management","eventDate":"2026-12-10","venue":"Milan","speakerName":"Prof. Giulia Romano","speakerSpecialty":"Cardiology","speakerTier":"National KOL","proposedFee":1500}'
sleep 3
T=$(firsttask clara); echo "clara task $T"
echo "== 2a. clara tries to approve 1500 (should be blocked)"; api clara -X POST $B/api/tasks/$T/complete -d '{"variables":{"complianceDecision":"APPROVED","complianceComment":"ok"}}'
echo "== 2b. marco tries to complete compliance task (SoD)"; api marco -X POST $B/api/tasks/$T/complete -d '{"variables":{"complianceDecision":"REJECTED","complianceComment":"x"}}'
echo "== 2c. clara rejects"; api clara -X POST $B/api/tasks/$T/complete -d '{"variables":{"complianceDecision":"REJECTED","recommendedFee":1200,"complianceComment":"€1,500 exceeds National KOL FMV tier. Please adjust to €1,200."}}'
sleep 3; T=$(firsttask marco); echo "marco task $T"
echo "== 3a. marco revises"; api marco -X POST $B/api/tasks/$T/complete -d '{"variables":{"proposedFee":1200,"revisionComment":"Adjusted per Compliance"}}'
sleep 3; T=$(firsttask clara)
echo "== 3b. clara approves"; api clara -X POST $B/api/tasks/$T/complete -d '{"variables":{"complianceDecision":"APPROVED","complianceComment":"Fee within FMV. Approved."}}'
sleep 3; T=$(firsttask elena)
echo "== 4. elena logistics"; api elena -X POST $B/api/tasks/$T/complete -d '{"variables":{"venueConfirmed":true,"materialsReady":true,"travelArranged":true}}'
sleep 3; T=$(firsttask elena)
echo "== 5. elena completion"; api elena -X POST $B/api/tasks/$T/complete -d '{"variables":{"eventHeld":true,"attendees":42}}'
sleep 5
R=$(api marco $B/api/requests | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['request_id'])")
api clara $B/api/requests/$R | python3 -c "
import sys,json;d=json.load(sys.stdin);print('STATUS',d['request']['status'],'fee',d['request']['proposed_fee'],'chain',d['chain'],'payment',bool(d['payment']),'report',bool(d['report']))
[print(' ',a['occurred_at'][11:19],a['actor'].ljust(15),a['action'].ljust(26),a['summary']) for a in d['audit']]"
api fabio $B/api/payments | head -c 400
