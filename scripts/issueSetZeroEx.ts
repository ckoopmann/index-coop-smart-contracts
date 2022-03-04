// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// When running the script with `npx hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
import { ethers } from "hardhat";
import { ExchangeIssuanceZeroEx } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import axios from "axios";
import qs from "qs";
import { Address } from "@utils/types";
import { getTxFee } from "../utils/test";
import { BigNumber, getDefaultProvider, Wallet, Signer } from "ethers";
import readline from "readline-sync";

const API_QUOTE_URL = "https://api.0x.org/swap/v1/quote";
async function getQuote(params: any) {
  const url = `${API_QUOTE_URL}?${qs.stringify(params)}`;
  console.log(`Getting quote from ${params.sellToken} to ${params.buyToken}`);
  console.log("Sending quote request to:", url);
  const response = await axios(url);
  return response.data;
}

async function logQuote(quote: any) {
  console.log("Sell Amount:", quote.sellAmount);
  console.log("Buy Amount:", quote.buyAmount);
  console.log("Swap Target:", quote.to);
  console.log("Allowance Target:", quote.allowanceTarget);
  console.log(
    "Sources:",
    quote.sources.filter((source: any) => source.proportion > "0"),
  );
  await decodeCallData(quote.data, quote.to);
}

async function decodeCallData(callData: string, proxyAddress: Address) {
  const API_KEY = "X28YB9Z9TQD4KSSC6A6QTKHYGPYGIP8D7I";
  const ABI_ENDPOINT = `https://api.etherscan.io/api?module=contract&action=getabi&apikey=${API_KEY}&address=`;
  const proxyAbi = await axios
    .get(ABI_ENDPOINT + proxyAddress)
    .then((response: any) => JSON.parse(response.data.result));
  const proxyContract = await ethers.getContractAt(proxyAbi, proxyAddress);
  await proxyContract.deployed();
  const implementation = await proxyContract.getFunctionImplementation(callData.slice(0, 10));
  console.log("Implementation Address: ", implementation);
  const abiResponse = await axios.get(ABI_ENDPOINT + implementation);
  const abi = JSON.parse(abiResponse.data.result);
  const iface = new ethers.utils.Interface(abi);
  const decodedTransaction = iface.parseTransaction({
    data: callData,
  });
  console.log("Called Function Signature: ", decodedTransaction.signature);
}

async function getIssuanceQuotes(
  setToken: SetToken,
  exchangeIssuance: ExchangeIssuanceZeroEx,
  issuanceModuleAddress: Address,
  isDebtIssuance: boolean,
  inputTokenAddress: Address,
  setAmount: BigNumber,
  slippagePercents: number,
  excludedSources: string | undefined = undefined,
): Promise<[string[], BigNumber]> {
  console.log("Getting issuance quotes");
  console.log("issuance module address:", issuanceModuleAddress);
  const issuanceModule = await ethers.getContractAt("IBasicIssuanceModule", issuanceModuleAddress);
  const result = await issuanceModule.getRequiredComponentUnitsForIssue(
    setToken.address,
    setAmount,
  );
  // console.log("result", result);
  const [components, positions] = await exchangeIssuance.getRequiredIssuanceComponents(
    issuanceModuleAddress,
    isDebtIssuance,
    setToken.address,
    setAmount,
  );
  console.log("Positions:", positions);
  const positionQuotes: string[] = [];
  let inputTokenAmount = BigNumber.from(0);
  // 0xAPI expects percentage as value between 0-1 e.g. 5% -> 0.05
  const slippagePercentage = slippagePercents / 100;

  for (const [index, component] of components.entries()) {
    console.log("\n\n###################COMPONENT QUOTE##################");
    const buyAmount = positions[index];
    const buyToken = component;
    const sellToken = inputTokenAddress;
    if (ethers.utils.getAddress(buyToken) == ethers.utils.getAddress(sellToken)) {
      console.log("Component equal to input token skipping zero ex api call");
      positionQuotes.push(ethers.utils.formatBytes32String("FOOBAR"));
      inputTokenAmount = inputTokenAmount.add(buyAmount);
    } else {
      const quote = await getQuote({
        buyToken,
        sellToken,
        buyAmount: buyAmount.toString(),
        excludedSources,
        slippagePercentage,
      });
      await logQuote(quote);
      positionQuotes.push(quote.data);
      inputTokenAmount = inputTokenAmount.add(BigNumber.from(quote.sellAmount));
    }
  }
  // I assume that this is the correct math to make sure we have enough weth to cover the slippage
  // based on the fact that the slippagePercentage is limited between 0.0 and 1.0 on the 0xApi
  // TODO: Review if correct
  inputTokenAmount = inputTokenAmount.mul(100).div(100 - slippagePercents);
  return [positionQuotes, inputTokenAmount];
}

async function main() {
  const exchangeIssuanceAddress = "0xf42ecdc112365ff79a745b4cf7d4c266bd6e4b25";

  const setAddress = "0x2aF1dF3AB0ab157e1E2Ad8F88A7D04fbea0c7dc6"; // BED
  const issuanceModuleAddress = "0xd8EF3cACe8b4907117a45B0b125c68560532F94D"; // Basic Issuance
  const inputTokenAddress = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // WETH
  const gasPriceProvider = getDefaultProvider();
  const gasPrice = await gasPriceProvider.getGasPrice();
  console.log("Gas Price:", ethers.utils.formatUnits(gasPrice, "gwei"));
  // const inputToken = await ethers.getContractAt("IERC20", inputTokenAddress);
  const isDebtIssuance = false;
  const setAmount = ethers.utils.parseEther("10");

  const setToken = (await ethers.getContractAt("ISetToken", setAddress)) as SetToken;

  let signerToUse: Signer;
  if (process.env.USE_DEPLOYER) {
    console.log("USING DEPLOYER KEY");
    signerToUse = new Wallet(process.env.PRODUCTION_MAINNET_DEPLOY_PRIVATE_KEY as string, ethers.provider);
  } else {
    console.log("using hardhat account");
    const signers = await ethers.getSigners();
    signerToUse = signers[0];
  }

  const issuerAddress = await signerToUse.getAddress();

  const exchangeIssuanceContract = (await ethers.getContractAt(
    "ExchangeIssuanceZeroEx",
    exchangeIssuanceAddress,
  )) as ExchangeIssuanceZeroEx;

  const [issuanceQuotes, inputAmount] = await getIssuanceQuotes(
    setToken,
    exchangeIssuanceContract,
    issuanceModuleAddress,
    isDebtIssuance,
    inputTokenAddress,
    setAmount,
    10,
  );
  console.log("IssuanceQuotes:", issuanceQuotes);
  console.log("InputAmount:", ethers.utils.formatEther(inputAmount));

  // console.log("Approving");
  // const approveTx = await inputToken
  //   .connect(signerToUse)
  //   .approve(exchangeIssuanceAddress, inputAmount);
  // console.log("approveTx:", approveTx.hash);
  // const approveTxFee = await getTxFee(approveTx);
  // console.log("approveTxFee:", ethers.utils.formatEther(approveTxFee));

  const ethBalanceBefore = await signerToUse.getBalance();
  console.log("ethBalanceBefore", ethers.utils.formatEther(ethBalanceBefore));
  const setBalanceBefore = await setToken.balanceOf(issuerAddress);
  console.log("setBalanceBefore", ethers.utils.formatUnits(setBalanceBefore, 18));
  console.log("estimating gas");
  const gasEstimate = await exchangeIssuanceContract.estimateGas.issueExactSetFromETH(
    setToken.address,
    setAmount,
    issuanceQuotes,
    issuanceModuleAddress,
    isDebtIssuance,
    { value: inputAmount, gasPrice },
  );
  const gasLimit = gasEstimate.mul(6).div(5); // increase gas limit by 20% to ensure fast mining

  console.log("gasEstimate:", ethers.utils.formatEther(gasPrice.mul(gasEstimate)));
  console.log("Issue transaction parameters", {
    setToken: setToken.address,
    paymentToken: "ETH",
    issuerAddress,
    setAmount: ethers.utils.formatEther(setAmount),
    maxInputAmount: ethers.utils.formatEther(inputAmount),
    gasPrice: `${ethers.utils.formatUnits(gasPrice, "gwei")} gwei`,
    gasCostEstimate: `${ethers.utils.formatEther(gasPrice.mul(gasEstimate))} ETH`,
    gasCostLimit: `${ethers.utils.formatEther(gasPrice.mul(gasLimit))} ETH`,
  });
  const answer = readline.question(
    "Do you want to continue and issue (press y to confirm or any other key to cancel)?",
  );
  if (answer !== "y") {
    console.log("Aborting");
    process.exit(1);
  }

  console.log("Issuing");
  const issueTx = await exchangeIssuanceContract
    .connect(signerToUse)
    .issueExactSetFromETH(
      setToken.address,
      setAmount,
      issuanceQuotes,
      issuanceModuleAddress,
      isDebtIssuance,
      { value: inputAmount, gasPrice, gasLimit },
    );
  console.log("issueTx", issueTx.hash);
  const issueTxFee = await getTxFee(issueTx);
  console.log("issueTxFee:", ethers.utils.formatEther(issueTxFee));
  console.log(
    "totalCost (max):",
    ethers.utils.formatEther(
      issueTxFee
        // .add(approveTxFee)
        .add(inputAmount),
    ),
  );
  console.log("Waiting for tx");
  await issueTx.wait();
  console.log("tx mined");
  const ethBalanceAfter = await signerToUse.getBalance();
  console.log("ethBalanceAfter", ethers.utils.formatEther(ethBalanceAfter));
  console.log("ethSpent", ethers.utils.formatEther(ethBalanceBefore.sub(ethBalanceAfter)));
  const setBalanceAfter = await setToken.balanceOf(issuerAddress);
  console.log("setBalanceAfter", ethers.utils.formatUnits(setBalanceAfter, 18));
  console.log("setObtained", ethers.utils.formatUnits(setBalanceAfter.sub(setBalanceBefore), 18));
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
