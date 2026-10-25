# Neon Four

A two-player live Connect Four game. Create a room, share its four-character code, and play from separate devices.

## Rules

- Take turns dropping a disc into one of seven columns; it falls to the lowest open space.
- Connect four discs horizontally, vertically, or diagonally to win.
- A full board with no four-in-a-row is a draw.
- The server validates turns, moves, and full columns.

## Start on Windows

1. Double-click `start-game.bat` and leave its window open.
2. Open **http://localhost:3000** in a browser. Do not open `public/index.html` directly as a file.
3. To play from another device on the same Wi-Fi, open `http://<host-computer-LAN-IP>:3000` there. For players on different networks, deploy the app publicly.

Requires Node.js 20+; no npm install is needed.

## Deploy a public URL

The included `render.yaml` configures a Render web service. Push this folder to a GitHub repository, then choose **New > Blueprint** in Render and select that repository. Render will provide a public `onrender.com` URL. The free service may sleep when idle, so the first connection after a period of inactivity can take a little time.
