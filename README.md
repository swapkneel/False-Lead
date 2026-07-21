# 🎭 False Lead

A real-time multiplayer social deduction game inspired by games like Spyfall and Impostor-style deduction games. Players join a lobby, discuss a secret word, identify the imposter, and compete across multiple rounds with unique game mechanics.

🌐 **Live Demo:** https://false-lead.vercel.app/

---

## 📌 Features

- 👥 Multiplayer rooms with unique room codes
- 🔐 User authentication
- ⚡ Real-time gameplay using Socket.IO
- 🗳️ Live voting system
- 🧠 Multiple round types
  - Normal Round
  - Reverse Spy
  - Similar Word
  - Chaos Round
- 📊 Live scoreboard
- 🏆 Multi-round winner calculation
- 🎨 Responsive modern UI
- 💾 Persistent MySQL database
- ☁️ Production deployment

---

## 🛠 Tech Stack

### Frontend

- React
- Vite
- React Router
- Socket.IO Client
- CSS

### Backend

- Node.js
- Express.js
- Socket.IO
- JWT Authentication

### Database

- MySQL

### Deployment

- Vercel (Frontend)
- Railway (Backend & Database)

---

## 📸 Screenshots

> Add gameplay screenshots here.

- Home Page
- Lobby
- Category Voting
- Discussion Phase
- Voting Phase
- Results Screen
- Final Scoreboard

---

## 🎮 Gameplay

1. Create or join a room.
2. Vote for a category.
3. Players receive secret words.
4. Discuss without revealing your word.
5. Vote for the suspected imposter.
6. Scores are calculated.
7. Multiple rounds determine the winner.

---

## 🚀 Local Setup

### Clone the repository

```bash
git clone https://github.com/swapkneel/False-Lead.git
cd False-Lead
```

### Backend

```bash
cd server
npm install
```

Create a `.env` file

```env
PORT=5000

DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=

JWT_SECRET=

CLIENT_URL=http://localhost:5173
```

Run

```bash
npm run dev
```

---

### Frontend

```bash
cd client
npm install
npm run dev
```

---

## 📂 Project Structure

```
FalseLead/
│
├── client/
│   ├── public/
│   ├── src/
│   │   ├── assets/
│   │   ├── components/
│   │   ├── context/
│   │   ├── pages/
│   │   ├── services/
│   │   ├── socket/
│   │   └── utils/
│   └── package.json
│
├── server/
│   ├── config/
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   ├── socket/
│   │   ├── handlers/
│   │   └── index.js
│   ├── utils/
│   ├── app.js
│   └── package.json
│
├── README.md
└── package.json
```

---

## 💡 Challenges Faced

One of the biggest challenges during development was debugging a production-only issue where players became stuck after voting.

The bug turned out to be a race condition between React route navigation and Socket.IO event listeners. It worked perfectly in local development but only surfaced after deployment, making it one of the most valuable debugging experiences during this project.

---

## 🔮 Future Improvements

- Friends System
- Public Matchmaking
- AI-generated Categories
- Player Statistics
- Match History
- Spectator Mode
- Voice Chat
- Mobile UI Improvements
- Docker Deployment

---

## 👨‍💻 Author

**Swapnil Goswami**

- GitHub: https://github.com/swapkneel
- Portfolio: https://portfolio-two-drab-32.vercel.app/
- LinkedIn: https://www.linkedin.com/in/swapnil-goswami-526aa6353/

---

⭐ If you like this project, consider giving it a star!
