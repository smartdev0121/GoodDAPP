const Config = {
    "env":"development",
    "serverUrl": process.env.REACT_APP_SERVER_URL || "http://localhost:3003",
    "infuraKey": process.env.REACT_APP_INFURA_KEY,
    "networkId": process.env.REACT_APP_NETWORK_ID || 42,
    "ethereum":{
      "42":{
        "network_id":42,
        "web3Transport":"WebSocket",
        "httpWeb3provider":"https://kovan.infura.io/v3/",
        "websocketWeb3Provider":"wss://kovan.infura.io/ws"
      },
      "3":{
        "network_id":3,
        "web3Transport":"WebSocket",
        "httpWeb3provider":"https://ropsten.infura.io/v3/",
        "websocketWeb3Provider":"wss://ropsten.infura.io/ws"
      }

    }
}

export default Config
