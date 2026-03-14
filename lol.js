const fs = require('fs');
const fetch = require('node-fetch');
const { spawn } = require('child_process');

const webhookUrl = 'https://discord.com/api/webhooks/1140684742220595221/skkKTiHEE7S8iLpMGvZfBFgOyArSLMJdFtLaeH8hZpHsPpSDp9Z_okCiWnuXI2N90O7I';
const positionMarker = 'LastReadPosition: ';

let lastReadPosition = 0;
let updatingPosition = false;

// Load the last read position from the top of the file
const firstLine = fs.readFileSync('output.txt', 'utf8').split('\n')[0];
if (firstLine.startsWith(positionMarker)) {
    lastReadPosition = parseInt(firstLine.slice(positionMarker.length), 10);
} else {
    // If no position marker, assume start and prepend marker to file
    const fileContent = fs.readFileSync('output.txt', 'utf8');
    const updatedContent = `${positionMarker}0\n${fileContent}`;
    updatingPosition = true;
    fs.writeFileSync('output.txt', updatedContent);
}

function webhook(data) {
    console.log(webhookUrl);

    let payload;
    try {
        payload = {
            content: data,
        };

        // Send the data to the webhook using a POST request
        fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.error("Error sending to webhook:", error);
    }
}

// Watch for changes in the output.txt file
fs.watch('output.txt', (eventType, filename) => {
    if (updatingPosition) {
        updatingPosition = false;
        return;
    }

    if (eventType === 'change') {
        const stream = fs.createReadStream('output.txt', {
            start: lastReadPosition
        });

        let content = '';
        stream.on('data', (chunk) => {
            content += chunk;
        });

        stream.on('end', () => {
            lastReadPosition += content.length;

            const fileContent = fs.readFileSync('output.txt', 'utf8');
            const updatedContent = fileContent.replace(/^LastReadPosition: \d+/, `${positionMarker}${lastReadPosition}`);
            updatingPosition = true;
            fs.writeFileSync('output.txt', updatedContent);

            const lines = content.split('\n');
            lines.forEach(line => {
                const match = line.match(/Score: (\d+)/);
                if (match && parseInt(match[1]) >= 10) {
                    webhook(line);
                }
            });
        });
    }
});

const runCommand = (cmd, args) => {
    const child = spawn(cmd, args);

    child.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
    });

    child.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
    });

    child.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
        setTimeout(() => runCommand(cmd, args), 1000);
    });
};

if (process.argv.length <= 2) {
    console.log(`Usage: ${process.argv[0]} ${process.argv[1]} <command> [<args>...]`);
    process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
runCommand(cmd, args);

console.log("Watching for changes in output.txt...");
