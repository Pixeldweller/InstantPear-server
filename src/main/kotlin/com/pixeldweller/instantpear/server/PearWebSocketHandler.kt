package com.pixeldweller.instantpear.server

import com.fasterxml.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.handler.TextWebSocketHandler
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@Component
class PearWebSocketHandler(private val objectMapper: ObjectMapper) : TextWebSocketHandler() {
    private val log = LoggerFactory.getLogger(PearWebSocketHandler::class.java)

    data class LobbyMember(val session: WebSocketSession, val userId: String, val userName: String)
    data class Lobby(val key: String?, val members: MutableList<LobbyMember> = mutableListOf())

    private val lobbies = ConcurrentHashMap<String, Lobby>()

    companion object {
        private val SILENT_TYPES = setOf(
            PearMessage.MOUSE_MOVE,
            PearMessage.DOCUMENT_CHANGE,
            PearMessage.OVERLAY_CURSOR,
            PearMessage.WEBRTC_ICE
        )
    }
    private val sessionToLobby = ConcurrentHashMap<String, String>()
    private val sessionToUserId = ConcurrentHashMap<String, String>()

    override fun afterConnectionEstablished(session: WebSocketSession) {
        log.info("[+] Connection from {}", session.remoteAddress)
    }

    override fun afterConnectionClosed(session: WebSocketSession, status: CloseStatus) {
        log.info("[-] Disconnected: {} ({})", session.remoteAddress, status)
        handleDisconnect(session)
    }

    override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
        val msg = try {
            objectMapper.readValue(message.payload, PearMessage::class.java)
        } catch (e: Exception) {
            log.warn("[!] Invalid message from {}: {}", session.remoteAddress, message.payload)
            return
        }

        if (msg.type !in SILENT_TYPES) {
            log.info("[>] {} from {}", msg.type, sessionToUserId[session.id] ?: session.remoteAddress)
        }

        when (msg.type) {
            PearMessage.CREATE_LOBBY -> handleCreateLobby(session, msg)
            PearMessage.JOIN_LOBBY -> handleJoinLobby(session, msg)
            PearMessage.LEAVE_LOBBY -> handleDisconnect(session)
            else -> handleBroadcast(session, message.payload, msg)
        }
    }

    override fun handleTransportError(session: WebSocketSession, exception: Throwable) {
        log.error("[!] Error from {}: {}", session.remoteAddress, exception.message)
        handleDisconnect(session)
    }

    private fun handleCreateLobby(session: WebSocketSession, msg: PearMessage) {
        val code = msg.lobbyCode ?: return sendError(session, "Missing lobby code")
        val key = msg.lobbyKey?.takeIf { it.isNotBlank() }

        if (lobbies.containsKey(code)) {
            return sendError(session, "Lobby '$code' already exists")
        }

        val userId = UUID.randomUUID().toString().take(8)
        val userName = msg.userName ?: "Host"
        val lobby = Lobby(key)
        lobby.members.add(LobbyMember(session, userId, userName))
        lobbies[code] = lobby
        sessionToLobby[session.id] = code
        sessionToUserId[session.id] = userId

        send(session, PearMessage(type = PearMessage.LOBBY_CREATED, lobbyCode = code, userId = userId))
        log.info("[*] Lobby created: '{}' by {} ({})", code, userName, userId)
    }

    private fun handleJoinLobby(session: WebSocketSession, msg: PearMessage) {
        val code = msg.lobbyCode ?: return sendError(session, "Missing lobby code")
        val key = msg.lobbyKey?.takeIf { it.isNotBlank() }

        val lobby = lobbies[code] ?: return sendError(session, "Lobby '$code' not found")
        if (lobby.key != null && lobby.key != key) return sendError(session, "Invalid lobby key")

        val userId = UUID.randomUUID().toString().take(8)
        val userName = msg.userName ?: "Guest"
        lobby.members.add(LobbyMember(session, userId, userName))
        sessionToLobby[session.id] = code
        sessionToUserId[session.id] = userId

        send(session, PearMessage(type = PearMessage.LOBBY_JOINED, lobbyCode = code, userId = userId))

        // Tell joiner about existing members
        for (existing in lobby.members) {
            if (existing.session.id != session.id) {
                send(session, PearMessage(type = PearMessage.USER_JOINED, userId = existing.userId, userName = existing.userName))
            }
        }

        // Notify others
        broadcastToOthers(session, code, PearMessage(type = PearMessage.USER_JOINED, userId = userId, userName = userName))
        log.info("[*] {} ({}) joined lobby: '{}' ({} members)", userName, userId, code, lobby.members.size)
    }

    private fun handleBroadcast(session: WebSocketSession, rawMessage: String, msg: PearMessage) {
        val code = sessionToLobby[session.id] ?: return
        val targetId = msg.targetUserId

        if (targetId != null) {
            val lobby = lobbies[code] ?: return
            val target = lobby.members.find { it.userId == targetId }
            if (target != null && target.session.isOpen) {
                target.session.sendMessage(TextMessage(rawMessage))
            }
        } else {
            broadcastRawToOthers(session, code, rawMessage)
        }
    }

    private fun handleDisconnect(session: WebSocketSession) {
        val code = sessionToLobby.remove(session.id) ?: return
        val userId = sessionToUserId.remove(session.id) ?: return
        val lobby = lobbies[code] ?: return

        val member = lobby.members.find { it.session.id == session.id }
        lobby.members.removeAll { it.session.id == session.id }

        if (lobby.members.isEmpty()) {
            lobbies.remove(code)
            log.info("[*] Lobby removed: '{}' (empty)", code)
        } else {
            broadcastToOthers(session, code, PearMessage(type = PearMessage.USER_LEFT, userId = userId, userName = member?.userName))
            log.info("[*] {} ({}) left lobby: '{}' ({} remaining)", member?.userName, userId, code, lobby.members.size)
        }
    }

    private fun broadcastToOthers(sender: WebSocketSession, lobbyCode: String, msg: PearMessage) {
        broadcastRawToOthers(sender, lobbyCode, objectMapper.writeValueAsString(msg))
    }

    private fun broadcastRawToOthers(sender: WebSocketSession, lobbyCode: String, raw: String) {
        val lobby = lobbies[lobbyCode] ?: return
        val textMessage = TextMessage(raw)
        lobby.members
            .filter { it.session.id != sender.id && it.session.isOpen }
            .forEach {
                try {
                    it.session.sendMessage(textMessage)
                } catch (_: Exception) {
                }
            }
    }

    private fun send(session: WebSocketSession, msg: PearMessage) {
        session.sendMessage(TextMessage(objectMapper.writeValueAsString(msg)))
    }

    private fun sendError(session: WebSocketSession, message: String) {
        log.warn("[!] Error sent to {}: {}", session.remoteAddress, message)
        send(session, PearMessage(type = PearMessage.ERROR, message = message))
    }
}
