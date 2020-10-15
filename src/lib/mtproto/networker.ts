import {isObject} from '../bin_utils';
import {convertToUint8Array, 
  bufferConcat, nextRandomInt, bytesToHex,
  bytesCmp, bigStringInt} from '../bin_utils';
import {TLDeserialization, TLSerialization} from './tl_utils';
import CryptoWorker from '../crypto/cryptoworker';
import AppStorage from '../storage';
import Schema from './schema';
import timeManager from './timeManager';
import NetworkerFactory from './networkerFactory';
import { logger, LogLevels } from '../logger';
import { Modes, App } from './mtproto_config';
import { InvokeApiOptions } from '../../types';
import { longToBytes } from '../crypto/crypto_utils';
import MTTransport from './transports/transport';

/// #if MTPROTO_HTTP_UPLOAD
// @ts-ignore
import HTTP from './transports/http';
// @ts-ignore
import Socket from './transports/websocket';
/// #elif MTPROTO_HTTP
// @ts-ignore
import HTTP from './transports/http';
/// #else
// @ts-ignore
import Socket from './transports/websocket';
/// #endif

//console.error('networker included!', new Error().stack);

export type MTMessageOptions = InvokeApiOptions & Partial<{
  noResponse: true,
  longPoll: true,
  
  notContentRelated: true,
  noSchedule: true,
  messageID: string,
}>;

export type MTMessage = InvokeApiOptions & MTMessageOptions & {
  msg_id: string,
  seq_no: number,
  body?: Uint8Array | number[],
  isAPI?: boolean,
  // only these four are important

  acked?: boolean,

  deferred?: {
    resolve: any,
    reject: any
  },

  container?: boolean,
  inner?: string[],

  // below - options

  notContentRelated?: true,
  noSchedule?: true,

  resultType?: string,

  singleInRequest?: true,
  longPoll?: true,
  noResponse?: true, // only with http (http_wait for longPoll)
};

export default class MTPNetworker {
  private authKeyUint8: Uint8Array;

  private upload: boolean;

  private lastServerMessages: Array<string> = [];

  private sentMessages: {
    [msgID: string]: MTMessage
  } = {};

  private pendingMessages: {[msgID: string]: number} = {};
  private pendingAcks: Array<string> = [];
  private pendingResends: Array<string> = [];
  private connectionInited = false;

  /// #if MTPROTO_HTTP || MTPROTO_HTTP_UPLOAD
  //private longPollInt: number;
  private longPollPending = 0;
  private nextReqTimeout: number;
  private nextReq: number = 0;
  private checkConnectionTimeout: number;
  private checkConnectionPeriod = 0;
  private sleepAfter = 0;
  private offline = false;
  /// #endif

  private seqNo: number = 0;
  private prevSessionID: Array<number> = [];
  private sessionID: Array<number> = [];

  private lastResendReq: {
    req_msg_id: string,
    resend_msg_ids: Array<string>
  } | null = null;

  //private transport: MTTransport;

  private log: ReturnType<typeof logger>;

  constructor(private dcID: number, private authKey: number[], private authKeyID: Uint8Array,
    private serverSalt: number[], private transport: MTTransport, private options: InvokeApiOptions = {}) {
    this.authKeyUint8 = convertToUint8Array(this.authKey);
    //this.authKeyID = sha1BytesSync(this.authKey).slice(-8);

    //console.trace('Create', dcID, options);

    this.upload = this.options.fileUpload || this.options.fileDownload;
    //this.log = logger('NET-' + dcID + (this.upload ? '-U' : ''), this.upload && this.dcID == 2 ? LogLevels.debug | LogLevels.warn | LogLevels.log | LogLevels.error : LogLevels.error);
    this.log = logger('NET-' + dcID + (this.upload ? '-U' : ''), LogLevels.log | LogLevels.error);
    this.log('constructor'/* , this.authKey, this.authKeyID, this.serverSalt */);

    /* // Test resend after bad_server_salt
    if(this.dcID == 1 && this.upload) {
      this.serverSalt[0] = 0;
    } */

    this.updateSession();

    // if(!NetworkerFactory.offlineInited) {
    //   NetworkerFactory.offlineInited = true;
    //   /* $rootScope.offline = true
    //   $rootScope.offlineConnecting = true */
    // }

    /// #if MTPROTO_HTTP_UPLOAD
    if(this.transport instanceof HTTP) {
      /* this.longPollInt =  */setInterval(this.checkLongPoll.bind(this), 10000);
      this.checkLongPoll();
    } else {
      (this.transport as Socket).networker = this;
    }
    /// #elif MTPROTO_HTTP
    //if(this.transport instanceof HTTP) {
      /* this.longPollInt =  */setInterval(this.checkLongPoll.bind(this), 10000);
      this.checkLongPoll();
    /// #else
    //} else {
      (this.transport as Socket).networker = this;
    //}
    /// #endif
  }

  public updateSession() {
    this.seqNo = 0;
    this.prevSessionID = this.sessionID;
    this.sessionID = [...new Uint8Array(8).randomize()];
  }

  public updateSentMessage(sentMessageID: string) {
    const sentMessage = this.sentMessages[sentMessageID];
    if(!sentMessage) {
      return false;
    }
    if(sentMessage.container) {
      const newInner: string[] = [];
      sentMessage.inner.forEach((innerSentMessageID) => {
        const innerSentMessage = this.updateSentMessage(innerSentMessageID);
        if(innerSentMessage) {
          newInner.push(innerSentMessage.msg_id);
        }
      })
      sentMessage.inner = newInner;
    }
  
    sentMessage.msg_id = timeManager.generateID();
    sentMessage.seq_no = this.generateSeqNo(
      sentMessage.notContentRelated ||
      sentMessage.container
    );
    this.sentMessages[sentMessage.msg_id] = sentMessage;
    delete this.sentMessages[sentMessageID];
  
    return sentMessage;
  }

  public generateSeqNo(notContentRelated?: boolean) {
    let seqNo = this.seqNo * 2;
  
    if(!notContentRelated) {
      seqNo++;
      this.seqNo++;
    }
  
    return seqNo;
  }

  public wrapMtpCall(method: string, params: any = {}, options: MTMessageOptions = {}) {
    const serializer = new TLSerialization({mtproto: true});
  
    serializer.storeMethod(method, params);
  
    const messageID = timeManager.generateID();
    const seqNo = this.generateSeqNo();
    const message = {
      msg_id: messageID,
      seq_no: seqNo,
      body: serializer.getBytes()
    };
  
    if(Modes.debug) {
      this.log('MT call', method, params, messageID, seqNo);
    }
  
    return this.pushMessage(message, options);
  }
  
  public wrapMtpMessage(object: any = {}, options: MTMessageOptions = {}) {
    const serializer = new TLSerialization({mtproto: true});
    serializer.storeObject(object, 'Object');
  
    const messageID = timeManager.generateID();
    const seqNo = this.generateSeqNo(options.notContentRelated);
    const message = {
      msg_id: messageID,
      seq_no: seqNo,
      body: serializer.getBytes()
    };
  
    if(Modes.debug) {
      this.log('MT message', object, messageID, seqNo);
    }
  
    return this.pushMessage(message, options);
  }

  public wrapApiCall(method: string, params: any = {}, options: InvokeApiOptions = {}) {
    let serializer = new TLSerialization(options);
  
    if(!this.connectionInited) { // this will call once for each new session
      ///////this.log('Wrap api call !this.connectionInited');
      
      let invokeWithLayer = Schema.API.methods.find(m => m.method == 'invokeWithLayer');
      if(!invokeWithLayer) throw new Error('no invokeWithLayer!');
      serializer.storeInt(+invokeWithLayer.id >>> 0, 'invokeWithLayer');

      // @ts-ignore
      serializer.storeInt(Schema.layer, 'layer');
  
      let initConnection = Schema.API.methods.find(m => m.method == 'initConnection');
      if(!initConnection) throw new Error('no initConnection!');
  
      serializer.storeInt(+initConnection.id >>> 0, 'initConnection');
      serializer.storeInt(0x0, 'flags');
      serializer.storeInt(App.id, 'api_id');
      serializer.storeString(navigator.userAgent || 'Unknown UserAgent', 'device_model');
      serializer.storeString(navigator.platform || 'Unknown Platform', 'system_version');
      serializer.storeString(App.version, 'app_version');
      serializer.storeString(navigator.language || 'en', 'system_lang_code');
      serializer.storeString('', 'lang_pack');
      serializer.storeString(navigator.language || 'en', 'lang_code');
      //serializer.storeInt(0x0, 'proxy');
      /* serializer.storeMethod('initConnection', {
        'flags': 0,
        'api_id': App.id,
        'device_model': navigator.userAgent || 'Unknown UserAgent',
        'system_version': navigator.platform || 'Unknown Platform',
        'app_version': App.version,
        'system_lang_code': navigator.language || 'en',
        'lang_pack': '',
        'lang_code': navigator.language || 'en'
      }); */
    }
  
    if(options.afterMessageID) {
      let invokeAfterMsg = Schema.API.methods.find(m => m.method == 'invokeAfterMsg');
      if(!invokeAfterMsg) throw new Error('no invokeAfterMsg!');

      this.log('Api call options.afterMessageID!');
      serializer.storeInt(+invokeAfterMsg.id >>> 0, 'invokeAfterMsg');
      serializer.storeLong(options.afterMessageID, 'msg_id');
    }
  
    options.resultType = serializer.storeMethod(method, params);

    /* if(method == 'account.updateNotifySettings') {
      this.log('api call body:', serializer.getBytes(true));
    } */
  
    var messageID = timeManager.generateID();
    var seqNo = this.generateSeqNo();
    var message = {
      msg_id: messageID,
      seq_no: seqNo,
      body: serializer.getBytes(true),
      isAPI: true
    };
  
    if(Modes.debug/*  || true */) {
      this.log('Api call', method, message, params, options);
    } else {
      this.log('Api call', method, params, options);
    }
  
    return this.pushMessage(message, options);
  }

  /// #if MTPROTO_HTTP || MTPROTO_HTTP_UPLOAD
  public checkLongPoll() {
    const isClean = this.cleanupSent();
    //this.log.error('Check lp', this.longPollPending, this.dcID, isClean, this);
    if((this.longPollPending && Date.now() < this.longPollPending) ||
      this.offline) {
      //this.log('No lp this time');
      return false;
    }

    AppStorage.get<number>('dc').then((baseDcID: number) => {
      if(isClean && (
          baseDcID != this.dcID ||
          this.upload ||
          (this.sleepAfter && Date.now() > this.sleepAfter)
        )) {
        //console.warn(dT(), 'Send long-poll for DC is delayed', this.dcID, this.sleepAfter);
        return;
      }

      this.sendLongPoll();
    });
  }

  public sendLongPoll() {
    let maxWait = 25000;

    this.longPollPending = Date.now() + maxWait;
    //this.log('Set lp', this.longPollPending, tsNow())
  
    this.wrapMtpCall('http_wait', {
      max_delay: 500,
      wait_after: 150,
      max_wait: maxWait
    }, {
      noResponse: true,
      longPoll: true
    }).then(() => {
      this.longPollPending = 0;
      setTimeout(this.checkLongPoll.bind(this), 0);
    }, (error: ErrorEvent) => {
      this.log('Long-poll failed', error);
    });
  }

  public checkConnection = (event: Event | string) => {
    /* $rootScope.offlineConnecting = true */
  
    this.log('Check connection', event);
    clearTimeout(this.checkConnectionTimeout);
    this.checkConnectionTimeout = 0;
  
    var serializer = new TLSerialization({mtproto: true});
    var pingID = [nextRandomInt(0xFFFFFFFF), nextRandomInt(0xFFFFFFFF)];
  
    serializer.storeMethod('ping', {
      ping_id: pingID
    });
  
    var pingMessage = {
      msg_id: timeManager.generateID(),
      seq_no: this.generateSeqNo(true),
      body: serializer.getBytes()
    };
  
    var self = this;
    this.sendEncryptedRequest(pingMessage, {
      timeout: 15000
    }).then((result) => {
      /* delete $rootScope.offlineConnecting */
      self.toggleOffline(false);
    }, () => {
      this.log('Delay ', self.checkConnectionPeriod * 1000);
      self.checkConnectionTimeout = setTimeout(self.checkConnection.bind(self), self.checkConnectionPeriod * 1000 | 0);
      self.checkConnectionPeriod = Math.min(60, self.checkConnectionPeriod * 1.5);
      /* setTimeout(function() {
        delete $rootScope.offlineConnecting
      }, 1000); */
    });
  };

  public toggleOffline(enabled: boolean) {
    // this.log('toggle ', enabled, this.dcID, this.iii)
    if(this.offline !== undefined && this.offline == enabled) {
      return false;
    }
  
    this.offline = enabled;
    /* $rootScope.offline = enabled;
    $rootScope.offlineConnecting = false; */

    if(this.offline) {
      clearTimeout(this.nextReqTimeout);
      this.nextReqTimeout = 0;
      this.nextReq = 0;
  
      if(this.checkConnectionPeriod < 1.5) {
        this.checkConnectionPeriod = 0;
      }
  
      this.checkConnectionTimeout = setTimeout(this.checkConnection.bind(this), this.checkConnectionPeriod * 1000 | 0);
      this.checkConnectionPeriod = Math.min(30, (1 + this.checkConnectionPeriod) * 1.5);
  
      document.body.addEventListener('online', this.checkConnection, false);
      document.body.addEventListener('focus', this.checkConnection, false);
    } else {
      this.checkLongPoll();

      this.scheduleRequest();
  
      document.body.removeEventListener('online', this.checkConnection);
      document.body.removeEventListener('focus', this.checkConnection);

      clearTimeout(this.checkConnectionTimeout);
      this.checkConnectionTimeout = 0;
    }
    
  }

  private handleSentEncryptedRequestHTTP(promise: ReturnType<MTPNetworker['sendEncryptedRequest']>, message: MTMessage, noResponseMsgs: string[]) {
    promise
    .then((result) => {
      this.toggleOffline(false);
      // this.log('parse for', message)
      this.parseResponse(result).then((response) => {
        if(Modes.debug) {
          this.log('Server response', this.dcID, response);
        }
  
        this.processMessage(response.response, response.messageID, response.sessionID);
  
        noResponseMsgs.forEach((msgID) => {
          if(this.sentMessages[msgID]) {
            var deferred = this.sentMessages[msgID].deferred;
            delete this.sentMessages[msgID];
            deferred.resolve();
          }
        });

        this.checkLongPoll();
  
        this.checkConnectionPeriod = Math.max(1.1, Math.sqrt(this.checkConnectionPeriod));
      });
    }, (error) => {
      this.log.error('Encrypted request failed', error, message);
  
      if(message.container) {
        message.inner.forEach((msgID: string) => {
          this.pendingMessages[msgID] = 0;
        });

        delete this.sentMessages[message.msg_id];
      } else {
        this.pendingMessages[message.msg_id] = 0;
      }
  
      noResponseMsgs.forEach((msgID) => {
        if(this.sentMessages[msgID]) {
          var deferred = this.sentMessages[msgID].deferred;
          delete this.sentMessages[msgID];
          delete this.pendingMessages[msgID];
          deferred.reject();
        }
      })
  
      this.toggleOffline(true);
    });
  }
  /// #endif

  // тут можно сделать таймаут и выводить дисконнект
  public pushMessage(message: {
    msg_id: string,
    seq_no: number,
    body: Uint8Array | number[],
    isAPI?: boolean
  }, options: MTMessageOptions = {}) {
    return new Promise((resolve, reject) => {
      this.sentMessages[message.msg_id] = Object.assign(message, options, {
        deferred: {resolve, reject}
      });

      // this.log('Networker pushMessage:', this.sentMessages[message.msg_id]);

      this.pendingMessages[message.msg_id] = 0;
    
      if(!options || !options.noSchedule) {
        this.scheduleRequest();
      }

      if(isObject(options)) {
        options.messageID = message.msg_id;
      }
    });
  }

  public pushResend(messageID: string, delay = 0) {
    const value = delay ? Date.now() + delay : 0;
    const sentMessage = this.sentMessages[messageID];
    if(sentMessage.container) {
      for(let i = 0, length = sentMessage.inner.length; i < length; i++) {
        this.pendingMessages[sentMessage.inner[i]] = value;
      }
    } else {
      this.pendingMessages[messageID] = value;
    }
  
    this.log('Resend due', messageID, this.pendingMessages);
  
    this.scheduleRequest(delay);
  }

  public async getMsgKey(dataWithPadding: ArrayBuffer, isOut: boolean) {
    const authKey = this.authKeyUint8;
    const x = isOut ? 0 : 8
    const msgKeyLargePlain = bufferConcat(authKey.subarray(88 + x, 88 + x + 32), dataWithPadding);

    const msgKeyLarge = await CryptoWorker.sha256Hash(msgKeyLargePlain);
    const msgKey = new Uint8Array(msgKeyLarge).subarray(8, 24);
    return msgKey;
  };

  public getAesKeyIv(msgKey: Uint8Array | number[], isOut: boolean): Promise<[Uint8Array, Uint8Array]> {
    var authKey = this.authKeyUint8;
    var x = isOut ? 0 : 8;
    var sha2aText = new Uint8Array(52);
    var sha2bText = new Uint8Array(52);
    var promises: Array<Promise<number[]>> = [];
  
    sha2aText.set(msgKey, 0);
    sha2aText.set(authKey.subarray(x, x + 36), 16);
    promises.push(CryptoWorker.sha256Hash(sha2aText));
  
    sha2bText.set(authKey.subarray(40 + x, 40 + x + 36), 0);
    sha2bText.set(msgKey, 36);
    promises.push(CryptoWorker.sha256Hash(sha2bText));

    return Promise.all(promises).then((results) => {
      var aesKey = new Uint8Array(32);
      var aesIv = new Uint8Array(32);
      var sha2a = new Uint8Array(results[0]);
      var sha2b = new Uint8Array(results[1]);
  
      aesKey.set(sha2a.subarray(0, 8));
      aesKey.set(sha2b.subarray(8, 24), 8);
      aesKey.set(sha2a.subarray(24, 32), 24);
  
      aesIv.set(sha2b.subarray(0, 8));
      aesIv.set(sha2a.subarray(8, 24), 8);
      aesIv.set(sha2b.subarray(24, 32), 24);
  
      return [aesKey, aesIv];
    });
  }

  public performScheduledRequest() {
    // this.log('scheduled', this.dcID, this.iii)

    /// #if MTPROTO_HTTP || MTPROTO_HTTP_UPLOAD
    if(this.offline) {
      this.log('Cancel scheduled');
      return false;
    }

    this.nextReq = 0;
    /// #endif

    if(this.pendingAcks.length) {
      const ackMsgIDs: Array<string> = this.pendingAcks.slice();

      // this.log('acking messages', ackMsgIDs)
      this.wrapMtpMessage({
        _: 'msgs_ack',
        msg_ids: ackMsgIDs
      }, {
        notContentRelated: true,
        noSchedule: true
      });
    }
  
    if(this.pendingResends.length) {
      const resendMsgIDs: Array<string> = this.pendingResends.slice();
      const resendOpts: MTMessageOptions = {
        noSchedule: true,
        notContentRelated: true,
        messageID: '' // will set in wrapMtpMessage->pushMessage
      };

      this.log('resendReq messages', resendMsgIDs);
      this.wrapMtpMessage({
        _: 'msg_resend_req',
        msg_ids: resendMsgIDs
      }, resendOpts);

      this.lastResendReq = {
        req_msg_id: resendOpts.messageID,
        resend_msg_ids: resendMsgIDs
      };
    }
  
    var message: MTPNetworker['sentMessages'][keyof MTPNetworker['sentMessages']];
    var messages: typeof message[] = [];
      
    var messagesByteLen = 0;
    var currentTime = Date.now();
    var hasApiCall = false;
    var hasHttpWait = false;
    var lengthOverflow = false;
    var singlesCount = 0;
    var self = this;
  
    for(let messageID in this.pendingMessages) {
      let value = this.pendingMessages[messageID];

      if(!value || value >= currentTime) {
        if(message = this.sentMessages[messageID]) {
          //this.log('performScheduledRequest message:', message);
          var messageByteLength = (/* message.body.byteLength ||  */message.body.length) + 32;
          if(!message.notContentRelated &&
            lengthOverflow) {
            continue; // maybe break here
          }

          if(!message.notContentRelated &&
            messagesByteLen &&
            messagesByteLen + messageByteLength > 655360) { // 640 Kb
            this.log.warn('lengthOverflow', message);
            lengthOverflow = true;
            continue; // maybe break here
          }

          if(message.singleInRequest) {
            singlesCount++;
            if(singlesCount > 1) {
              continue; // maybe break here
            }
          }

          messages.push(message);
          messagesByteLen += messageByteLength;
          if(message.isAPI) {
            hasApiCall = true;
          } else if(message.longPoll) {
            hasHttpWait = true;
          }
        } else {
          // this.log(message, messageID)
        }

        delete self.pendingMessages[messageID];
      }
    }
  
    /// #if MTPROTO_HTTP_UPLOAD
    if(this.transport instanceof HTTP)
    /// #endif
    /// #if MTPROTO_HTTP || MTPROTO_HTTP_UPLOAD
    if(hasApiCall && !hasHttpWait) {
      var serializer = new TLSerialization({mtproto: true});
      serializer.storeMethod('http_wait', {
        max_delay: 500,
        wait_after: 150,
        max_wait: 3000
      });

      messages.push({
        msg_id: timeManager.generateID(),
        seq_no: this.generateSeqNo(),
        body: serializer.getBytes()
      });
    }
    /// #endif
  
    if(!messages.length) {
      // this.log('no scheduled messages')
      return;
    }
  
    var noResponseMsgs: Array<string> = [];
  
    if(messages.length > 1) {
      var container = new TLSerialization({
        mtproto: true,
        startMaxLength: messagesByteLen + 64
      });

      container.storeInt(0x73f1f8dc, 'CONTAINER[id]');
      container.storeInt(messages.length, 'CONTAINER[count]');

      var innerMessages: string[] = [];
      messages.forEach((message, i) => {
        container.storeLong(message.msg_id, 'CONTAINER[' + i + '][msg_id]');
        innerMessages.push(message.msg_id);
        container.storeInt(message.seq_no, 'CONTAINER[' + i + '][seq_no]');
        container.storeInt(message.body.length, 'CONTAINER[' + i + '][bytes]');
        container.storeRawBytes(message.body, 'CONTAINER[' + i + '][body]');
        if(message.noResponse) {
          noResponseMsgs.push(message.msg_id);
        }
      });
  
      var containerSentMessage: MTMessage = {
        msg_id: timeManager.generateID(),
        seq_no: this.generateSeqNo(true),
        container: true,
        inner: innerMessages
      };
  
      message = Object.assign({
        body: container.getBytes(true)
      }, containerSentMessage);
  
      this.sentMessages[message.msg_id] = containerSentMessage;
  
      if(Modes.debug || true) {
        this.log('Container', innerMessages, message.msg_id, message.seq_no);
      }
    } else {
      if(message.noResponse) {
        noResponseMsgs.push(message.msg_id);
      }

      this.sentMessages[message.msg_id] = message;
    }
  
    this.pendingAcks = [];

    let promise = this.sendEncryptedRequest(message);
    
    /// #if MTPROTO_HTTP_UPLOAD
    if(!(this.transport instanceof HTTP)) {
      if(noResponseMsgs.length) this.log.error('noResponseMsgs length!', noResponseMsgs);
    } else {
      this.handleSentEncryptedRequestHTTP(promise, message, noResponseMsgs);
    }
    /// #elif !MTPROTO_HTTP
    //if(!(this.transport instanceof HTTP)) {
      if(noResponseMsgs.length) this.log.error('noResponseMsgs length!', noResponseMsgs);
    //} else {
    /// #else
      this.handleSentEncryptedRequestHTTP(promise, message, noResponseMsgs);
    //}
    /// #endif 
  
    if(lengthOverflow || singlesCount > 1) {
      this.scheduleRequest();
    }
  }

  public async getEncryptedMessage(dataWithPadding: ArrayBuffer) {
    let msgKey = await this.getMsgKey(dataWithPadding, true);
    let keyIv = await this.getAesKeyIv(msgKey, true);
    // this.log('after msg key iv')

    let encryptedBytes = await CryptoWorker.aesEncrypt(dataWithPadding, keyIv[0], keyIv[1]);
    // this.log('Finish encrypt')

    return {
      bytes: encryptedBytes,
      msgKey: msgKey
    };
  }

  public getDecryptedMessage(msgKey: Uint8Array | number[], encryptedData: Uint8Array | number[]): Promise<ArrayBuffer> {
    // this.log('get decrypted start')
    return this.getAesKeyIv(msgKey, false).then((keyIv) => {
      // this.log('after msg key iv')
      return CryptoWorker.aesDecrypt(encryptedData, keyIv[0], keyIv[1]);
    });
  }

  public sendEncryptedRequest(message: MTMessage, options: any = {}) {
    const self = this;

    this.log.debug('Send encrypted', message, options, this.authKeyID);
    // console.trace()
    const data = new TLSerialization({
      startMaxLength: message.body.length + 2048
    });

    data.storeIntBytes(this.serverSalt, 64, 'salt');
    data.storeIntBytes(this.sessionID, 64, 'session_id');
  
    data.storeLong(message.msg_id, 'message_id');
    data.storeInt(message.seq_no, 'seq_no');
    
    data.storeInt(message.body.length, 'message_data_length');
    data.storeRawBytes(message.body, 'message_data');
  
    const dataBuffer = data.getBuffer();
  
    const paddingLength = (16 - (data.offset % 16)) + 16 * (1 + nextRandomInt(5));
    const padding = [...new Uint8Array(paddingLength).randomize()];
    //MTProto.secureRandom.nextBytes(padding);

    const dataWithPadding = bufferConcat(dataBuffer, padding);
    // this.log('Adding padding', dataBuffer, padding, dataWithPadding)
    // this.log('auth_key_id', bytesToHex(self.authKeyID))

    /* if(message.fileUpload) {
      this.log('Send encrypted: body length:', (message.body as ArrayBuffer).byteLength, paddingLength, dataWithPadding);
    } */
  
    return this.getEncryptedMessage(dataWithPadding).then((encryptedResult) => {
      this.log.debug('Got encrypted out message', encryptedResult);

      const request = new TLSerialization({
        startMaxLength: encryptedResult.bytes.length + 256
      });
      request.storeIntBytes(self.authKeyID, 64, 'auth_key_id');
      request.storeIntBytes(encryptedResult.msgKey, 128, 'msg_key');
      request.storeRawBytes(encryptedResult.bytes, 'encrypted_data');
  
      //var requestData = xhrSendBuffer ? request.getBuffer() : request.getBytes(true) as Uint8Array;
      const requestData = request.getBytes(true);

      const baseError = {
        code: 406,
        type: 'NETWORK_BAD_RESPONSE',
        transport: this.transport
      };

      if(message.fileUpload) {
        this.log('Send encrypted: requestData length:', requestData.length, requestData.length % 16, paddingLength % 16, paddingLength, data.offset);
      }

      const promise = this.transport.send(requestData);
      /// #if !MTPROTO_HTTP && !MTPROTO_HTTP_UPLOAD
      /* if(!(this.transport instanceof HTTP)) */ return promise;
      /// #else
      if(!(this.transport instanceof HTTP)) return promise;

      return promise.then((result) => {
        if(!result || !result.byteLength) {
          return Promise.reject(baseError);
        }

        return result;
      }, (error) => {
        if(!error.message && !error.type) {
          error = Object.assign(baseError, {
          type: 'NETWORK_BAD_REQUEST',
          originalError: error
          });
        }
        return Promise.reject(error);
      });
      /// #endif
    });
  }

  public parseResponse(responseBuffer: Uint8Array) {
    this.log.debug('Start parsing response'/* , responseBuffer */);

    let self = this;
    let deserializer = new TLDeserialization(responseBuffer);
  
    let authKeyID = deserializer.fetchIntBytes(64, true, 'auth_key_id');
    if(!bytesCmp(authKeyID, this.authKeyID)) {
      throw new Error('[MT] Invalid server auth_key_id: ' + authKeyID.hex);
    }
    let msgKey = deserializer.fetchIntBytes(128, true, 'msg_key');
    let encryptedData = deserializer.fetchRawBytes(responseBuffer.byteLength - deserializer.getOffset(), true, 'encrypted_data');
  
    return self.getDecryptedMessage(msgKey, encryptedData).then((dataWithPadding) => {
      // this.log('after decrypt')
      return self.getMsgKey(dataWithPadding, false).then((calcMsgKey) => {
        if(!bytesCmp(msgKey, calcMsgKey)) {
          this.log.warn('[MT] msg_keys', msgKey, calcMsgKey);
          this.updateSession(); // fix 28.01.2020
          throw new Error('[MT] server msgKey mismatch, updating session');
        }
        // this.log('after msgKey check')
  
        let deserializer = new TLDeserialization(dataWithPadding, {mtproto: true});
  
        /* let salt =  */deserializer.fetchIntBytes(64, false, 'salt'); // need
        let sessionID = deserializer.fetchIntBytes(64, false, 'session_id');
        let messageID = deserializer.fetchLong('message_id');
  
        if(!bytesCmp(sessionID, self.sessionID) &&
          (!self.prevSessionID || !bytesCmp(sessionID, self.prevSessionID))) {
          this.log.warn('Sessions', sessionID, self.sessionID, self.prevSessionID, dataWithPadding);
          //this.updateSession();
          //this.sessionID = sessionID;
          throw new Error('[MT] Invalid server session_id: ' + bytesToHex(sessionID));
        }
  
        let seqNo = deserializer.fetchInt('seq_no');
  
        let totalLength = dataWithPadding.byteLength;
  
        let messageBodyLength = deserializer.fetchInt('message_data[length]');
        let offset = deserializer.getOffset();
  
        if((messageBodyLength % 4) ||
          messageBodyLength > totalLength - offset) {
          throw new Error('[MT] Invalid body length: ' + messageBodyLength);
        }
        let messageBody = deserializer.fetchRawBytes(messageBodyLength, true, 'message_data');
  
        offset = deserializer.getOffset();
        let paddingLength = totalLength - offset;
        if(paddingLength < 12 || paddingLength > 1024) {
          throw new Error('[MT] Invalid padding length: ' + paddingLength);
        }
  
        //let buffer = bytesToArrayBuffer(messageBody);
        deserializer = new TLDeserialization(/* buffer */messageBody, {mtproto: true});
        // костыль
        deserializer.override = {
          mt_message: (function(this: TLDeserialization, result: any, field: string) {
            result.msg_id = this.fetchLong(field + '[msg_id]');
            result.seqno = this.fetchInt(field + '[seqno]');
            result.bytes = this.fetchInt(field + '[bytes]');

            var offset = this.getOffset();

            //self.log('mt_message!!!!!', result, field);

            try {
              result.body = this.fetchObject('Object', field + '[body]');
            } catch(e) {
              self.log.error('parse error', e.message, e.stack);
              result.body = {
                _: 'parse_error',
                error: e
              };
            }
            if(this.offset != offset + result.bytes) {
              // console.warn(dT(), 'set offset', this.offset, offset, result.bytes)
              // this.log(result)
              this.offset = offset + result.bytes;
            }
            // this.log('override message', result)
          }).bind(deserializer),
          mt_rpc_result: (function(this: TLDeserialization, result: any, field: any) {
            result.req_msg_id = this.fetchLong(field + '[req_msg_id]');

            var sentMessage = self.sentMessages[result.req_msg_id];
            var type = sentMessage && sentMessage.resultType || 'Object';

            if(result.req_msg_id && !sentMessage) {
              // console.warn(dT(), 'Result for unknown message', result);
              return;
            }

            result.result = this.fetchObject(type, field + '[result]');
            // self.log(dT(), 'override rpc_result', sentMessage, type, result);
          }).bind(deserializer)
        };

        var response = deserializer.fetchObject('', 'INPUT');
  
        return {
          response: response,
          messageID: messageID,
          sessionID: sessionID,
          seqNo: seqNo
        };
      });
    });
  }

  public applyServerSalt(newServerSalt: string) {
    var serverSalt = longToBytes(newServerSalt);
  
    AppStorage.set({
      ['dc' + this.dcID + '_server_salt']: bytesToHex(serverSalt)
    });
  
    this.serverSalt = serverSalt;
    return true;
  }

  public scheduleRequest(delay = 0) {
    /// #if !MTPROTO_HTTP && !MTPROTO_HTTP_UPLOAD
    /* clearTimeout(this.nextReqTimeout);
    this.nextReqTimeout = self.setTimeout(this.performScheduledRequest.bind(this), delay || 0);
    return; */
    return this.performScheduledRequest();
    /// #else
    if(!(this.transport instanceof HTTP)) return this.performScheduledRequest();
    if(this.offline/*  && this.transport instanceof HTTP */) {
      this.checkConnection('forced schedule');
    }

    /* if(delay && !(this.transport instanceof HTTP)) {
      delay = 0;
    } */

    var nextReq = Date.now() + delay;
  
    if(delay && this.nextReq && this.nextReq <= nextReq) {
      return false;
    }
  
    // this.log('schedule req', delay)
    // console.trace()
  
    clearTimeout(this.nextReqTimeout);
    this.nextReqTimeout = 0;
    if(delay > 0) {
      this.nextReqTimeout = self.setTimeout(this.performScheduledRequest.bind(this), delay || 0);
    } else {
      setTimeout(this.performScheduledRequest.bind(this), 0);
    }
  
    this.nextReq = nextReq;
    /// #endif
  }

  public ackMessage(msgID: string) {
    // this.log('ack message', msgID)
    this.pendingAcks.push(msgID);
    this.scheduleRequest(30000);
  }
  
  public reqResendMessage(msgID: string) {
    this.log('Req resend', msgID);
    this.pendingResends.push(msgID);
    this.scheduleRequest(100);
  }

  public cleanupSent() {
    let notEmpty = false;
    // this.log('clean start', this.dcID/*, this.sentMessages*/)
    Object.keys(this.sentMessages).forEach((msgID) => {
      const message = this.sentMessages[msgID];
    
      // this.log('clean iter', msgID, message)
      if(message.notContentRelated && this.pendingMessages[msgID] === undefined) {
        // this.log('clean notContentRelated', msgID)
        delete this.sentMessages[msgID];
      } else if(message.container) {
        for(let i = 0; i < message.inner.length; i++) {
          if(this.sentMessages[message.inner[i]] !== undefined) {
            // this.log('clean failed, found', msgID, message.inner[i], this.sentMessages[message.inner[i]].seq_no)
            notEmpty = true;
            return;
          }
        }
        // this.log('clean container', msgID)
        delete this.sentMessages[msgID];
      } else {
        notEmpty = true;
      }
    });
  
    return !notEmpty;
  }

  public processMessageAck(messageID: string) {
    var sentMessage = this.sentMessages[messageID];
    if(sentMessage && !sentMessage.acked) {
      delete sentMessage.body;
      sentMessage.acked = true;
  
      return true;
    }
  
    return false;
  }

  public processError(rawError: {error_message: string, error_code: number}) {
    var matches = (rawError.error_message || '').match(/^([A-Z_0-9]+\b)(: (.+))?/) || [];
    rawError.error_code = rawError.error_code;
  
    return {
      code: !rawError.error_code || rawError.error_code <= 0 ? 500 : rawError.error_code,
      type: matches[1] || 'UNKNOWN',
      description: matches[3] || ('CODE#' + rawError.error_code + ' ' + rawError.error_message),
      originalError: rawError
    };
  }

  /**
   * только для сокета, возможно это будет неправильно работать, но в тесте сработало правильно
   */
  public resend() {
    for(let id in this.sentMessages) {
      const msg = this.sentMessages[id];
      if(msg.body) {
        this.pushResend(id);
      }
    }
  }

  public requestMessageStatus() {
    const ids: string[] = [];
    for(const id in this.sentMessages) {
      const message = this.sentMessages[id];
      if(message.isAPI && message.fileUpload) {
        ids.push(message.msg_id);
      }
    }

    this.wrapMtpMessage({
      _: 'msgs_state_req',
      msg_ids: ids
    }, {
      notContentRelated: true
    }).then(res => {
      this.log('status', res);
    });
  }

  // * https://core.telegram.org/mtproto/service_messages_about_messages#notice-of-ignored-error-message
  public processMessage(message: any, messageID: string, sessionID: Uint8Array | number[]) {
    var msgidInt = parseInt(messageID/* .toString(10) */.substr(0, -10), 10);
    if(msgidInt % 2) {
      this.log.warn('[MT] Server even message id: ', messageID, message);
      return;
    }

    this.log.debug('process message', message, messageID, sessionID);

    switch(message._) {
      case 'msg_container':
        var len = message.messages.length;
        for(var i = 0; i < len; i++) {
          this.processMessage(message.messages[i], message.messages[i].msg_id, sessionID);
        }
        break;
  
      case 'bad_server_salt':
        this.log('Bad server salt', message);
        var sentMessage = this.sentMessages[message.bad_msg_id];
        if(!sentMessage || sentMessage.seq_no != message.bad_msg_seqno) {
          this.log(message.bad_msg_id, message.bad_msg_seqno);
          throw new Error('[MT] Bad server salt for invalid message');
        }

        this.applyServerSalt(message.new_server_salt);
        this.pushResend(message.bad_msg_id);
        this.ackMessage(messageID);
        
        /* // simulate disconnect
        try {
          this.log('networker state:', this);
          // @ts-ignore
          this.transport.ws.close(1000);
        } catch(err) {
          this.log.error('transport', this.transport, err);
        } */

        break;
  
      case 'bad_msg_notification':
        var sentMessage = this.sentMessages[message.bad_msg_id];
        this.log.error('Bad msg notification', message, sentMessage);
        if(!sentMessage || sentMessage.seq_no != message.bad_msg_seqno) {
          this.log(message.bad_msg_id, message.bad_msg_seqno);
          throw new Error('[MT] Bad msg notification for invalid message');
        }
  
        if(message.error_code == 16 || message.error_code == 17) {
          if(timeManager.applyServerTime(
              bigStringInt(messageID).shiftRight(32).toString(10)
            )) {
            this.log('Update session');
            this.updateSession();
          }

          const badMessage = this.updateSentMessage(message.bad_msg_id);
          if(badMessage) this.pushResend(badMessage.msg_id); // fix 23.01.2020
          this.ackMessage(messageID);
        }
        break;
  
      case 'message':
        if(this.lastServerMessages.indexOf(messageID) != -1) {
          // console.warn('[MT] Server same messageID: ', messageID)
          this.ackMessage(messageID);
          return;
        }
        this.lastServerMessages.push(messageID);
        if(this.lastServerMessages.length > 100) {
          this.lastServerMessages.shift();
        }
        this.processMessage(message.body, message.msg_id, sessionID);
        break;
  
      case 'new_session_created':
        this.ackMessage(messageID);

        this.log.debug('new_session_created', message);
        //this.updateSession();
  
        this.processMessageAck(message.first_msg_id);
        this.applyServerSalt(message.server_salt);
  
        AppStorage.get<number>('dc').then((baseDcID: number) => {
          if(baseDcID == this.dcID && !this.upload && NetworkerFactory.updatesProcessor) {
            NetworkerFactory.updatesProcessor(message, true);
          }
        });
        break;
  
      case 'msgs_ack':
        for(var i = 0; i < message.msg_ids.length; i++) {
          this.processMessageAck(message.msg_ids[i]);
        }
        break;
  
      case 'msg_detailed_info':
        if(!this.sentMessages[message.msg_id]) {
          this.ackMessage(message.answer_msg_id);
          break;
        }
      case 'msg_new_detailed_info':
        if(this.pendingAcks.indexOf(message.answer_msg_id)) {
          break;
        }
        this.reqResendMessage(message.answer_msg_id);
        break;
  
      case 'msgs_state_info':
        this.ackMessage(message.answer_msg_id);
        if(this.lastResendReq && 
          this.lastResendReq.req_msg_id == message.req_msg_id && 
          this.pendingResends.length
        ) {
          var badMsgID, pos;
          for(let i = 0; i < this.lastResendReq.resend_msg_ids.length; i++) {
            badMsgID = this.lastResendReq.resend_msg_ids[i];
            pos = this.pendingResends.indexOf(badMsgID);
            if(pos != -1) {
              this.pendingResends.splice(pos, 1);
            }
          }
        }
        break;
  
      case 'rpc_result':
        this.ackMessage(messageID);
  
        var sentMessageID = message.req_msg_id;
        var sentMessage = this.sentMessages[sentMessageID];

        this.processMessageAck(sentMessageID);
        if(sentMessage) {
          var deferred = sentMessage.deferred;
          if(message.result._ == 'rpc_error') {
            var error = this.processError(message.result);
            this.log('Rpc error', error);
            if(deferred) {
              deferred.reject(error);
            }
          } else {
            if(deferred) {
              if(Modes.debug) {
                this.log.debug('Rpc response', message.result);
              } else {
                var dRes = message.result._;
                if(!dRes) {
                  if(message.result.length > 5) {
                    dRes = '[..' + message.result.length + '..]';
                  } else {
                    dRes = message.result;
                  }
                }
                this.log.debug('Rpc response', dRes, sentMessage);
              }

              sentMessage.deferred.resolve(message.result);
            }

            if(sentMessage.isAPI && !this.connectionInited) {
              this.connectionInited = true;
              ////this.log('Rpc set connectionInited to:', this.connectionInited);
            }
          }
  
          delete this.sentMessages[sentMessageID];
        }
        break;
  
      default:
        this.ackMessage(messageID);

        this.log.debug('Update', message);
        
        if(NetworkerFactory.updatesProcessor !== null) {
          NetworkerFactory.updatesProcessor(message, true);
        }
        break;
    }
  }
}
