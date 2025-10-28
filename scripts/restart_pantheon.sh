#!/bin/bash

# Script to restart the Pantheon service on LACNET VMs

# Configuration
MAINNET_IP="34.73.228.200"
TESTNET_IP="35.185.112.219"
USER="jscrui"

SSH_KEY="$HOME/.ssh/id_ed25519"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to restart Pantheon on a VM
restart_pantheon() {
    local ip=$1
    local name=$2
    
    echo -e "${GREEN}Connecting to $name ($ip)...${NC}"
    
    ssh -o StrictHostKeyChecking=no ${USER}@${ip} "sudo service pantheon restart"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Pantheon restarted successfully on $name${NC}"
    else
        echo -e "${RED}✗ Error restarting Pantheon on $name${NC}"
        return 1
    fi
}

# Main
echo "=== LACNET Pantheon restart script ==="
echo ""
echo -e "${YELLOW}Select network:${NC}"
echo "1) Mainnet"
echo "2) Testnet"
echo "3) Both"
echo ""
read -p "Option: " option

case $option in
    1)
        restart_pantheon $MAINNET_IP "MAINNET"
        ;;
    2)
        restart_pantheon $TESTNET_IP "TESTNET"
        ;;
    3)
        restart_pantheon $MAINNET_IP "MAINNET"
        echo ""
        restart_pantheon $TESTNET_IP "TESTNET"
        ;;
    *)
        echo -e "${RED}Invalid option${NC}"
        exit 1
        ;;
esac

echo ""
echo "=== Process completed ==="
