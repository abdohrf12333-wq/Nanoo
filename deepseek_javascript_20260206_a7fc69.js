const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes } = require('discord.js');
const CryptoJS = require('crypto-js');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB Connection
mongoose.connect('mongodb://localhost:27017/discord-bot-builder', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('Connected to MongoDB');
}).catch(err => {
    console.error('MongoDB connection error:', err);
});

// Encryption
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'your-secure-key-here';

function encrypt(text) {
    return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
}

function decrypt(ciphertext) {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
}

// Schemas
const commandSchema = new mongoose.Schema({
    deviceId: {
        type: String,
        required: true,
        index: true
    },
    name: {
        type: String,
        required: true,
        trim: true,
        lowercase: true
    },
    description: {
        type: String,
        default: ''
    },
    response: {
        type: String,
        default: ''
    },
    code: {
        type: String,
        default: ''
    },
    usageCount: {
        type: Number,
        default: 0
    },
    lastUsed: {
        type: Date,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

const botSchema = new mongoose.Schema({
    deviceId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    token: {
        type: String,
        required: true
    },
    botId: {
        type: String,
        default: ''
    },
    username: {
        type: String,
        default: ''
    },
    isActive: {
        type: Boolean,
        default: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastActive: {
        type: Date,
        default: Date.now
    }
});

const logSchema = new mongoose.Schema({
    deviceId: {
        type: String,
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ['command', 'bot', 'error', 'system'],
        required: true
    },
    message: {
        type: String,
        required: true
    },
    data: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
});

const Command = mongoose.model('Command', commandSchema);
const Bot = mongoose.model('Bot', botSchema);
const Log = mongoose.model('Log', logSchema);

// Bot Manager
class BotManager {
    constructor() {
        this.activeBots = new Map();
        this.botInfo = new Map();
        this.commandsCache = new Map();
    }

    async startBot(deviceId, encryptedToken) {
        try {
            if (this.activeBots.has(deviceId)) {
                await this.stopBot(deviceId);
            }

            const decryptedToken = decrypt(encryptedToken);
            if (!decryptedToken) {
                throw new Error('Invalid token');
            }

            const client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent
                ]
            });

            this.setupClientEvents(client, deviceId);
            await client.login(decryptedToken);

            this.activeBots.set(deviceId, client);
            this.botInfo.set(deviceId, {
                id: client.user.id,
                username: client.user.username,
                online: true,
                guilds: client.guilds.cache.size
            });

            await Bot.findOneAndUpdate(
                { deviceId },
                {
                    token: encryptedToken,
                    botId: client.user.id,
                    username: client.user.username,
                    isActive: true,
                    lastActive: new Date()
                },
                { upsert: true, new: true }
            );

            await this.registerCommands(deviceId);

            await Log.create({
                deviceId,
                type: 'bot',
                message: 'Bot started successfully',
                data: { botId: client.user.id, username: client.user.username }
            });

            return {
                success: true,
                botInfo: this.botInfo.get(deviceId)
            };

        } catch (error) {
            console.error(`Error starting bot for device ${deviceId}:`, error);
            
            await Log.create({
                deviceId,
                type: 'error',
                message: 'Failed to start bot',
                data: { error: error.message }
            });

            throw error;
        }
    }

    setupClientEvents(client, deviceId) {
        client.on('ready', async () => {
            console.log(`Bot ${client.user.tag} is ready!`);
            
            this.botInfo.set(deviceId, {
                id: client.user.id,
                username: client.user.username,
                online: true,
                guilds: client.guilds.cache.size
            });

            await Log.create({
                deviceId,
                type: 'system',
                message: 'Bot is ready',
                data: { 
                    botId: client.user.id,
                    username: client.user.username,
                    guildCount: client.guilds.cache.size
                }
            });
        });

        client.on('interactionCreate', async (interaction) => {
            if (!interaction.isCommand()) return;

            try {
                const command = await Command.findOne({
                    deviceId,
                    name: interaction.commandName
                });

                if (!command) {
                    await interaction.reply({ 
                        content: 'هذا الأمر غير متوفر حالياً.',
                        ephemeral: true 
                    });
                    return;
                }

                command.usageCount += 1;
                command.lastUsed = new Date();
                await command.save();

                await Log.create({
                    deviceId,
                    type: 'command',
                    message: `Command executed: /${command.name}`,
                    data: {
                        userId: interaction.user.id,
                        username: interaction.user.username,
                        guildId: interaction.guildId,
                        channelId: interaction.channelId
                    }
                });

                if (command.code) {
                    try {
                        await this.executeCommandCode(interaction, command.code);
                    } catch (codeError) {
                        console.error('Error executing command code:', codeError);
                        await interaction.reply({
                            content: `حدث خطأ في تنفيذ الكود: ${codeError.message}`,
                            ephemeral: true
                        });
                    }
                } else if (command.response) {
                    await interaction.reply({
                        content: command.response,
                        ephemeral: command.name.includes('private')
                    });
                }

            } catch (error) {
                console.error('Error handling interaction:', error);
                
                await Log.create({
                    deviceId,
                    type: 'error',
                    message: 'Error handling interaction',
                    data: { error: error.message }
                });

                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ 
                        content: 'حدث خطأ في تنفيذ الأمر.', 
                        ephemeral: true 
                    });
                } else {
                    await interaction.reply({ 
                        content: 'حدث خطأ في تنفيذ الأمر.', 
                        ephemeral: true 
                    });
                }
            }
        });

        client.on('error', async (error) => {
            console.error(`Bot error for device ${deviceId}:`, error);
            
            await Log.create({
                deviceId,
                type: 'error',
                message: 'Bot encountered an error',
                data: { error: error.message }
            });
        });

        client.on('disconnect', async () => {
            this.botInfo.set(deviceId, {
                ...this.botInfo.get(deviceId),
                online: false
            });

            await Log.create({
                deviceId,
                type: 'system',
                message: 'Bot disconnected'
            });
        });
    }

    async executeCommandCode(interaction, code) {
        const context = {
            interaction,
            console: {
                log: (...args) => console.log('[Command Code]', ...args),
                error: (...args) => console.error('[Command Code]', ...args),
                warn: (...args) => console.warn('[Command Code]', ...args)
            },
            Date,
            Math,
            JSON,
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval
        };

        const asyncCode = `
            return (async () => {
                ${code}
            })();
        `;

        const func = new Function(...Object.keys(context), asyncCode);
        return await func(...Object.values(context));
    }

    async registerCommands(deviceId) {
        try {
            const client = this.activeBots.get(deviceId);
            if (!client) return;

            const commands = await Command.find({ deviceId });
            
            const formattedCommands = commands.map(cmd => ({
                name: cmd.name,
                description: cmd.description || 'No description',
                options: []
            }));

            const bot = await Bot.findOne({ deviceId });
            const decryptedToken = decrypt(bot.token);
            
            const rest = new REST({ version: '10' }).setToken(decryptedToken);

            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: formattedCommands }
            );

            this.commandsCache.set(deviceId, commands);

            await Log.create({
                deviceId,
                type: 'system',
                message: 'Commands registered',
                data: { commandCount: commands.length }
            });

        } catch (error) {
            console.error(`Error registering commands for device ${deviceId}:`, error);
            
            await Log.create({
                deviceId,
                type: 'error',
                message: 'Failed to register commands',
                data: { error: error.message }
            });
        }
    }

    async stopBot(deviceId) {
        try {
            const client = this.activeBots.get(deviceId);
            if (client) {
                await client.destroy();
                this.activeBots.delete(deviceId);
                this.botInfo.delete(deviceId);

                await Bot.findOneAndUpdate(
                    { deviceId },
                    { isActive: false }
                );

                await Log.create({
                    deviceId,
                    type: 'bot',
                    message: 'Bot stopped'
                });

                return true;
            }
            return false;
        } catch (error) {
            console.error(`Error stopping bot for device ${deviceId}:`, error);
            throw error;
        }
    }

    async getBotStatus(deviceId) {
        const info = this.botInfo.get(deviceId);
        if (info) {
            return info;
        }

        const bot = await Bot.findOne({ deviceId });
        if (bot) {
            return {
                id: bot.botId,
                username: bot.username,
                online: this.activeBots.has(deviceId),
                guilds: 0
            };
        }

        return null;
    }

    async destroyAllBots() {
        const promises = [];
        for (const [deviceId, client] of this.activeBots) {
            promises.push(this.stopBot(deviceId));
        }
        await Promise.all(promises);
    }
}

const botManager = new BotManager();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', limiter);

// Serve frontend files
app.use(express.static(__dirname));

// API Routes
app.post('/api/bot/start', async (req, res) => {
    try {
        const { deviceId, token } = req.body;

        if (!deviceId || !token) {
            return res.status(400).json({ error: 'Device ID and token are required' });
        }

        const encryptedToken = encrypt(token);
        if (!encryptedToken) {
            return res.status(400).json({ error: 'Invalid token format' });
        }

        const result = await botManager.startBot(deviceId, encryptedToken);

        res.json({
            success: true,
            message: 'Bot started successfully',
            botInfo: result.botInfo
        });

    } catch (error) {
        console.error('Error starting bot:', error);
        res.status(500).json({ 
            error: 'Failed to start bot',
            details: error.message 
        });
    }
});

app.get('/api/bot/status', async (req, res) => {
    try {
        const { deviceId } = req.query;

        if (!deviceId) {
            return res.status(400).json({ error: 'Device ID is required' });
        }

        const status = await botManager.getBotStatus(deviceId);
        
        if (status) {
            res.json(status);
        } else {
            res.status(404).json({ 
                online: false,
                message: 'Bot not found' 
            });
        }

    } catch (error) {
        console.error('Error getting bot status:', error);
        res.status(500).json({ 
            error: 'Failed to get bot status',
            details: error.message 
        });
    }
});

app.get('/api/bot/logs', async (req, res) => {
    try {
        const { deviceId, limit = 50 } = req.query;

        if (!deviceId) {
            return res.status(400).json({ error: 'Device ID is required' });
        }

        const logs = await Log.find({ deviceId })
            .sort({ timestamp: -1 })
            .limit(parseInt(limit))
            .lean();

        res.json(logs);

    } catch (error) {
        console.error('Error getting logs:', error);
        res.status(500).json({ 
            error: 'Failed to get logs',
            details: error.message 
        });
    }
});

app.get('/api/commands', async (req, res) => {
    try {
        const { deviceId } = req.query;

        if (!deviceId) {
            return res.status(400).json({ error: 'Device ID is required' });
        }

        const commands = await Command.find({ deviceId })
            .sort({ createdAt: -1 })
            .lean();

        res.json(commands);

    } catch (error) {
        console.error('Error getting commands:', error);
        res.status(500).json({ 
            error: 'Failed to get commands',
            details: error.message 
        });
    }
});

app.post('/api/commands', async (req, res) => {
    try {
        const { deviceId, name, description, response, code } = req.body;

        if (!deviceId || !name) {
            return res.status(400).json({ 
                error: 'Device ID and command name are required' 
            });
        }

        const existingCommand = await Command.findOne({ 
            deviceId, 
            name: name.toLowerCase() 
        });

        if (existingCommand) {
            return res.status(400).json({ 
                error: 'Command with this name already exists' 
            });
        }

        const command = new Command({
            deviceId,
            name: name.toLowerCase(),
            description: description || '',
            response: response || '',
            code: code || ''
        });

        await command.save();

        await botManager.registerCommands(deviceId);

        res.status(201).json({
            success: true,
            message: 'Command created successfully',
            command
        });

    } catch (error) {
        console.error('Error creating command:', error);
        res.status(500).json({ 
            error: 'Failed to create command',
            details: error.message 
        });
    }
});

app.put('/api/commands/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { deviceId, name, description, response, code } = req.body;

        if (!deviceId) {
            return res.status(400).json({ error: 'Device ID is required' });
        }

        const command = await Command.findOneAndUpdate(
            { _id: id, deviceId },
            {
                name: name ? name.toLowerCase() : undefined,
                description,
                response,
                code,
                updatedAt: new Date()
            },
            { new: true }
        );

        if (!command) {
            return res.status(404).json({ error: 'Command not found' });
        }

        await botManager.registerCommands(deviceId);

        res.json({
            success: true,
            message: 'Command updated successfully',
            command
        });

    } catch (error) {
        console.error('Error updating command:', error);
        res.status(500).json({ 
            error: 'Failed to update command',
            details: error.message 
        });
    }
});

app.delete('/api/commands/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { deviceId } = req.query;

        if (!deviceId) {
            return res.status(400).json({ error: 'Device ID is required' });
        }

        const command = await Command.findOneAndDelete({ 
            _id: id, 
            deviceId 
        });

        if (!command) {
            return res.status(404).json({ error: 'Command not found' });
        }

        await botManager.registerCommands(deviceId);

        res.json({
            success: true,
            message: 'Command deleted successfully'
        });

    } catch (error) {
        console.error('Error deleting command:', error);
        res.status(500).json({ 
            error: 'Failed to delete command',
            details: error.message 
        });
    }
});

// Serve pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Frontend available at http://localhost:${PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down...');
    botManager.destroyAllBots();
    process.exit(0);
});