import { createServer } from 'http';
import { Server } from 'socket.io';
import mysql from 'mysql2/promise';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

// Database connection
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "blockcred-sui",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const server = createServer();
const io = new Server(server, {
  cors: {
    origin: "*", // Add your frontend URLs
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_room', async (data) => {
    const { order_id, user_id, user_type } = data;
    
    try {
      // Verify user has access to this order
      const [orders] = await db.query(
        'SELECT * FROM orders WHERE id = ? AND (buyer_id = ? OR seller_id = ?)',
        [order_id, user_id, user_id]
      );
      
        socket.join(order_id);
        socket.user_id = user_id;
        socket.user_type = user_type;
        socket.order_id = order_id;
        
        console.log(`User ${user_id} joined room ${order_id}`);
        
        // Send recent messages
        const [messages] = await db.query(
          `SELECT m.*, 
                  CASE 
                    WHEN m.sent_by = 'buyer' THEN bu.username 
                    ELSE su.username 
                  END as username
           FROM messages m 
           JOIN users bu ON m.buyer_id = bu.id 
           JOIN users su ON m.seller_id = su.id 
           WHERE m.order_id = ? 
           ORDER BY m.created_at ASC 
           LIMIT 50`, 
          [order_id] 
        );
        
        socket.emit('recent_messages', messages);

    } catch (error) {
      console.log(`Error joining room: ${error.message}`)
      socket.emit('error', error.message);
    }
  });

  socket.on('send_message', async (data) => {
    const { message, image_url } = data;
    const { user_id, user_type, order_id } = socket;
    
    if (!user_id || !order_id) {
      socket.emit('error', 'Not authenticated');
      return;
    }
    
    try {
      const [orders] = await db.query('SELECT * FROM orders WHERE id = ?', [order_id]);
      const order = orders[0];
      const messageId = uuidv4();

      await db.query(
        `INSERT INTO messages (id, room_id, order_id, buyer_id, seller_id, message, image_url, sent_by, created_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [messageId, order_id, order_id, order.buyer_id, order.seller_id, message, image_url, user_type]
      );

      const [users] = await db.query(
        'SELECT username FROM users WHERE id = ?',
        [user_id]
      );

      const messageData = {
        id: messageId,
        room_id: order_id,
        order_id,
        buyer_id: order.buyer_id,
        seller_id: order.seller_id,
        message,
        image_url,
        sent_by: user_type,
        created_at: new Date(),
        username: users[0]?.username
      };

      io.to(order_id).emit('new_message', messageData);
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', 'Failed to send message');
    }
  });

  socket.on('report_message', async (data) => {
    const { message_id } = data;
    try {
      await db.query(
        'UPDATE messages SET reported = TRUE WHERE id = ?',
        [message_id]
      );
      socket.emit('message_reported', { success: true });
    } catch (error) {
      console.error('Error reporting message:', error);
      socket.emit('error', 'Failed to report message');
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});