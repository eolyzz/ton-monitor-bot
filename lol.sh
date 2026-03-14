#!/bin/bash

# Check if any arguments were provided
if [ "$#" -eq 0 ]; then
    echo "Usage: $0 <command> [<args>...]"
    exit 1
fi

# Infinite loop
while true; do
    # Run the provided command and wait for it to finish
    "$@" & PID=$!
    
    # Wait for the process to exit
    wait $PID
    
    # Sleep for a short interval before attempting to restart
    sleep 1
done
