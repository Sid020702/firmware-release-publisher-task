#!/bin/bash
set -e

cd /app

# copy publisher from solution
cp -r /solution/publisher /app/publisher

# start gateway
node distribution-gateway/server.js &

# wait until gateway responds
for i in $(seq 1 15); do
  node -e "fetch('http://localhost:7070/v1/signing-key/current').then(()=>process.exit(0)).catch(()=>process.exit(1));" 2>/dev/null && break
  sleep 1
done

npm run report --silent
