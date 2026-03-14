#!/bin/bash

COMMAND="$@"

if [ -z "$COMMAND" ]; then
    echo "Please provide a command to run."
    exit 1
fi

while true; do
    # Check if the program is running
    if ! pgrep -f "$COMMAND" > /dev/null; then
        # Start the program if not running
        $COMMAND &
    fi
    # Wait for a minute before checking again
    sleep 60
done
Save this script to a file, for instance, keep_alive.sh. Make it executable:

bash
Copy code
chmod +x keep_alive.sh
Then you can run your program with:

bash
Copy code
./keep_alive.sh ./profanity2.x64 --contract --matching 00da7a00 -z 04ce0966a41297ec967f69f58268abf8a319947209b500bd71920f37e47af0fe5551cdb6cd1dfec2b9f389434ef6cded9ac1a148c2e59b3f820a2244729d454407
This script will check every minute if your custom command is running and restart it if it's not.

Still, for a production setup, using a dedicated tool like supervisord or setting up a systemd service would be more appropriate.





