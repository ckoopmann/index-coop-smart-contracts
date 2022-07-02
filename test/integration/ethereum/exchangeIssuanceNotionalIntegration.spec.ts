import "module-alias/register";
import { BigNumber } from "ethers";
import { ethers, network } from "hardhat";
import { Account, Address, ForkedTokens } from "@utils/types";
import { getTxFee } from "@utils/test";
import { DebtIssuanceModule, ExchangeIssuanceNotional } from "@utils/contracts/index";
import { SetToken } from "@utils/contracts/setV2";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import { ProtocolUtils } from "@utils/common";

import {
  getAccounts,
  getForkedTokens,
  getWaffleExpect,
  initializeForkedTokens,
} from "@utils/index";
import {
  IController,
  INotionalProxy,
  INotionalTradeModule,
  IWrappedfCashFactory,
  IWrappedfCashComplete,
  SetTokenCreator,
} from "../../../typechain";
import { ADDRESS_ZERO } from "@utils/constants";
import { IERC20 } from "@typechain/IERC20";
import { PRODUCTION_ADDRESSES, STAGING_ADDRESSES } from "./addresses";
import { impersonateAccount, upgradeNotionalProxy, getCurrencyIdAndMaturity } from "./utils";

const expect = getWaffleExpect();

const tokenAddresses: Record<string, string> = {
  cDai: "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643",
  // cUsdc: "0x39AA39c021dfbaE8faC545936693aC917d5E7563",
  cEth: "0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5",
};

const underlyingTokens: Record<string, string> = {
  cDai: "dai",
  cUsdc: "usdc",
  cEth: "weth",
};

const USE_STAGING_ADDRESSES = true;

enum Exchange {
  None,
  Quickswap,
  Sushiswap,
  UniV3,
}

type SwapData = {
  path: Address[];
  fees: number[];
  pool: Address;
  exchange: Exchange;
};

const emptySwapData: SwapData = {
  path: [],
  fees: [],
  pool: ADDRESS_ZERO,
  exchange: Exchange.None,
};

if (process.env.INTEGRATIONTEST) {
  describe("ExchangeIssuanceNotional", () => {
    let owner: Account;
    let deployer: DeployHelper;
    let manager: Account;
    let tokens: ForkedTokens;

    let debtIssuanceModule: DebtIssuanceModule;
    const addresses = USE_STAGING_ADDRESSES ? STAGING_ADDRESSES : PRODUCTION_ADDRESSES;

    let snapshotId: number;

    beforeEach(async () => {
      snapshotId = await network.provider.send("evm_snapshot", []);
      [owner, manager] = await getAccounts();

      deployer = new DeployHelper(owner.wallet);

      debtIssuanceModule = (await ethers.getContractAt(
        "IDebtIssuanceModule",
        STAGING_ADDRESSES.set.debtIssuanceModuleV2,
      )) as DebtIssuanceModule;

      await initializeForkedTokens(deployer);
      tokens = getForkedTokens();
    });

    afterEach(async () => {
      await network.provider.send("evm_revert", [snapshotId]);
    });

    describe("When notional proxy is upgraded and wrapper factory deployed", () => {
      beforeEach(async () => {
        await upgradeNotionalProxy(owner.wallet);
      });
      for (const [assetTokenName, assetTokenAddress] of Object.entries(tokenAddresses)) {
        describe(`When asset token is ${assetTokenName}`, () => {
          let underlyingToken: IERC20;

          beforeEach(async () => {
            underlyingToken = tokens[underlyingTokens[assetTokenName]];
            const whaleBalance = await underlyingToken.balanceOf(
              await underlyingToken.signer.getAddress(),
            );
            await underlyingToken.transfer(owner.address, whaleBalance.div(2));
            underlyingToken = underlyingToken.connect(owner.wallet);
          });

          describe("When WrappedfCash is deployed", () => {
            let wrappedfCashInstance: IWrappedfCashComplete;
            let currencyId: number;
            let maturity: BigNumber;
            let wrappedfCashFactory: IWrappedfCashFactory;

            beforeEach(async () => {
              wrappedfCashFactory = (await ethers.getContractAt(
                "IWrappedfCashFactory",
                STAGING_ADDRESSES.lending.notional.wrappedfCashFactory,
              )) as IWrappedfCashFactory;
              ({ currencyId, maturity } = await getCurrencyIdAndMaturity(assetTokenAddress, 0));
              const wrappedfCashAddress = await wrappedfCashFactory.callStatic.deployWrapper(
                currencyId,
                maturity,
              );
              await wrappedfCashFactory.deployWrapper(currencyId, maturity);

              wrappedfCashInstance = (await ethers.getContractAt(
                "contracts/interfaces/IWrappedfCash.sol:IWrappedfCashComplete",
                wrappedfCashAddress,
                owner.wallet,
              )) as IWrappedfCashComplete;
            });

            describe("When setToken is deployed", () => {
              let wrappedfCashPosition: BigNumber;
              let underlyingPosition: BigNumber;
              let initialSetBalance: BigNumber;
              let setToken: SetToken;
              let setTokenCreator: SetTokenCreator;
              let notionalTradeModule: INotionalTradeModule;
              let controller: IController;
              const setTokenName = "TestSet";
              const setTokenSymbol = "TEST";
              beforeEach(async () => {
                wrappedfCashPosition = ethers.utils.parseUnits("2", 8);
                underlyingPosition = ethers.utils.parseEther("1");

                notionalTradeModule = (await ethers.getContractAt(
                  "INotionalTradeModule",
                  STAGING_ADDRESSES.set.notionalTradeModule,
                )) as INotionalTradeModule;

                controller = (await ethers.getContractAt(
                  "IController",
                  STAGING_ADDRESSES.set.controller,
                )) as IController;

                setTokenCreator = await deployer.setV2.deploySetTokenCreator(controller.address);

                const controllerOwner = await impersonateAccount(await controller.owner());
                await controller.connect(controllerOwner).addFactory(setTokenCreator.address);

                const txHash = await setTokenCreator.create(
                  [wrappedfCashInstance.address, underlyingToken.address],
                  [wrappedfCashPosition, underlyingPosition],
                  [debtIssuanceModule.address, notionalTradeModule.address],
                  manager.address,
                  setTokenName,
                  setTokenSymbol,
                );

                const retrievedSetAddress = await new ProtocolUtils(
                  ethers.provider,
                ).getCreatedSetTokenAddress(txHash.hash);

                setToken = (await ethers.getContractAt(
                  "ISetToken",
                  retrievedSetAddress,
                )) as SetToken;

                expect(await setToken.isPendingModule(debtIssuanceModule.address)).to.be.true;

                // Initialize debIssuance module
                await debtIssuanceModule.connect(manager.wallet).initialize(
                  setToken.address,
                  ether(0.1),
                  ether(0), // No issue fee
                  ether(0), // No redeem fee
                  owner.address,
                  ADDRESS_ZERO,
                );

                const notionalTradeModuleOwner = await impersonateAccount(
                  await notionalTradeModule.owner(),
                );
                await notionalTradeModule
                  .connect(notionalTradeModuleOwner)
                  .updateAllowedSetToken(setToken.address, true);
                await notionalTradeModule.connect(manager.wallet).initialize(setToken.address);
                await notionalTradeModule
                  .connect(manager.wallet)
                  .setRedeemToUnderlying(setToken.address, true);

                const underlyingTokenBalance = await underlyingToken.balanceOf(owner.address);
                initialSetBalance = ethers.utils.parseEther("1");

                await underlyingToken.approve(
                  wrappedfCashInstance.address,
                  ethers.constants.MaxUint256,
                );

                await wrappedfCashInstance.mintViaUnderlying(
                  underlyingTokenBalance,
                  wrappedfCashPosition,
                  owner.address,
                  0,
                );
                await wrappedfCashInstance.approve(
                  debtIssuanceModule.address,
                  ethers.constants.MaxUint256,
                );

                await underlyingToken.approve(
                  debtIssuanceModule.address,
                  ethers.constants.MaxUint256,
                );
                await debtIssuanceModule.issue(setToken.address, initialSetBalance, owner.address);
              });

              describe("When exchangeIssuance is deployed", () => {
                let exchangeIssuance: ExchangeIssuanceNotional;
                beforeEach(async () => {
                  exchangeIssuance = await deployer.extensions.deployExchangeIssuanceNotional(
                    tokens.weth.address,
                    STAGING_ADDRESSES.set.controller,
                    wrappedfCashFactory.address,
                    notionalTradeModule.address,
                    addresses.dexes.uniV2.router,
                    addresses.dexes.sushiswap.router,
                    addresses.dexes.uniV3.router,
                    addresses.dexes.uniV3.quoter,
                    addresses.dexes.curve.addressProvider,
                    addresses.dexes.curve.calculator,
                  );
                });

                describe("#getFilteredComponentsRedemption", () => {
                  let subjectSetToken: Address;
                  let subjectSetAmount: BigNumber;
                  let subjectIssuanceModule: Address;
                  let subjectIsDebtIssuance: boolean;
                  let redeemAmount: BigNumber;
                  let setAmountEth: number;
                  let subjectSlippage: BigNumber;
                  beforeEach(async () => {
                    subjectSetToken = setToken.address;
                    setAmountEth = 1;
                    subjectSetAmount = ethers.utils.parseEther(setAmountEth.toString());
                    subjectIssuanceModule = debtIssuanceModule.address;
                    subjectIsDebtIssuance = true;
                    redeemAmount = await wrappedfCashInstance.previewRedeem(
                      wrappedfCashPosition.mul(setAmountEth),
                    );
                    subjectSlippage = ether(0.0001);
                  });
                  function subject() {
                    return exchangeIssuance.getFilteredComponentsRedemption(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectIssuanceModule,
                      subjectIsDebtIssuance,
                      subjectSlippage,
                    );
                  }
                  it("should return correct components", async () => {
                    const [filteredComponents] = await subject();
                    expect(ethers.utils.getAddress(filteredComponents[0])).to.eq(
                      ethers.utils.getAddress(underlyingToken.address),
                    );
                    expect(filteredComponents[1]).to.eq(ADDRESS_ZERO);
                  });
                  it("should return correct units", async () => {
                    const [, filteredUnits] = await subject();
                    const expectedAmount = redeemAmount
                      .mul(ether(1).sub(subjectSlippage))
                      .div(ether(1));
                    expect(filteredUnits[0]).to.eq(
                      expectedAmount.add(underlyingPosition.mul(setAmountEth)),
                    );
                  });
                });

                describe("#getFilteredComponentsIssuance", () => {
                  let subjectSetToken: Address;
                  let subjectSetAmount: BigNumber;
                  let subjectIssuanceModule: Address;
                  let subjectIsDebtIssuance: boolean;
                  let setAmountEth: number;
                  let mintAmount: BigNumber;
                  let subjectSlippage: BigNumber;
                  beforeEach(async () => {
                    subjectSetToken = setToken.address;
                    setAmountEth = 1;
                    subjectSetAmount = ethers.utils.parseEther(setAmountEth.toString());
                    subjectIssuanceModule = debtIssuanceModule.address;
                    subjectIsDebtIssuance = true;
                    mintAmount = await wrappedfCashInstance.previewMint(
                      wrappedfCashPosition.mul(setAmountEth),
                    );
                    subjectSlippage = ether(0.0001);
                  });
                  function subject() {
                    return exchangeIssuance.getFilteredComponentsIssuance(
                      subjectSetToken,
                      subjectSetAmount,
                      subjectIssuanceModule,
                      subjectIsDebtIssuance,
                      subjectSlippage,
                    );
                  }
                  it("should return correct components", async () => {
                    const [filteredComponents] = await subject();
                    expect(ethers.utils.getAddress(filteredComponents[0])).to.eq(
                      ethers.utils.getAddress(underlyingToken.address),
                    );
                    expect(filteredComponents[1]).to.eq(ADDRESS_ZERO);
                  });
                  it("should return correct units", async () => {
                    const [, filteredUnits] = await subject();
                    const expectedAmount = mintAmount
                      .mul(ether(1).add(subjectSlippage))
                      .div(ether(1));
                    expect(filteredUnits[0]).to.eq(
                      expectedAmount.add(underlyingPosition.mul(setAmountEth)),
                    );
                  });
                });

                describe("When set token is approved", () => {
                  beforeEach(async () => {
                    await exchangeIssuance.approveSetToken(
                      setToken.address,
                      debtIssuanceModule.address,
                    );
                  });

                  describe("#issueExactSetFromETH", () => {
                    let subjectSetToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectMaxAmountInputToken: BigNumber;
                    let subjectComponentQuotes: SwapData[];
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let caller: Account;

                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      subjectSetAmount = ethers.utils.parseEther("1");
                      subjectIssuanceModule = debtIssuanceModule.address;
                      subjectIsDebtIssuance = true;
                      subjectSlippage = ether(0.0001);
                      caller = owner;
                    });

                    function subject() {
                      return exchangeIssuance
                        .connect(caller.wallet)
                        .issueExactSetFromETH(
                          subjectSetToken,
                          subjectSetAmount,
                          subjectComponentQuotes,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                          { gasLimit: 750000000, value: subjectMaxAmountInputToken },
                        );
                    }
                    [false, true].forEach(hasMatured => {
                      describe(`when component has ${!hasMatured ? "not " : ""}matured`, () => {
                        beforeEach(async () => {
                          if (hasMatured) {
                            await network.provider.send("evm_setNextBlockTimestamp", [
                              maturity.toNumber() + 1,
                            ]);
                            await network.provider.send("evm_mine", []);
                            // TODO: Remove this statement and fix related issues
                            await notionalTradeModule.redeemMaturedPositions(setToken.address);
                          }
                          const [
                            filteredComponents,
                            filteredUnits,
                          ] = await exchangeIssuance.getFilteredComponentsRedemption(
                            subjectSetToken,
                            subjectSetAmount,
                            subjectIssuanceModule,
                            subjectIsDebtIssuance,
                            subjectSlippage,
                          );
                          subjectComponentQuotes = filteredComponents.map((component: Address) => {
                            return {
                              path: [tokens.weth.address, component],
                              fees: [3000],
                              pool: ADDRESS_ZERO,
                              exchange: Exchange.UniV3,
                            };
                          });
                          if (
                            ethers.utils.getAddress(filteredComponents[0]) !=
                            ethers.utils.getAddress(tokens.weth.address)
                          ) {
                            subjectMaxAmountInputToken = (await caller.wallet.getBalance()).div(10);
                          } else {
                            subjectMaxAmountInputToken = filteredUnits[0].mul(2);
                          }
                        });

                        it("should issue correct amount of set token", async () => {
                          const balanceBefore = await setToken.balanceOf(caller.address);
                          await subject();
                          const issuedAmount = (await setToken.balanceOf(caller.address)).sub(
                            balanceBefore,
                          );
                          expect(issuedAmount).to.eq(subjectSetAmount);
                        });

                        it("should spend correct amount of input token", async () => {
                          const balanceBefore = await caller.wallet.getBalance();
                          const txFee = await getTxFee(await subject());
                          const spentAmount = balanceBefore
                            .sub(await caller.wallet.getBalance())
                            .sub(txFee);
                          expect(spentAmount).to.be.lte(subjectMaxAmountInputToken);
                        });
                      });
                    });
                  });

                  describe("#issueExactSetFromToken", () => {
                    let subjectSetToken: Address;
                    let subjectInputToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectMaxAmountInputToken: BigNumber;
                    let subjectComponentQuotes: SwapData[];
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let caller: Account;

                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      subjectSetAmount = ethers.utils.parseEther("1");
                      subjectIssuanceModule = debtIssuanceModule.address;
                      subjectIsDebtIssuance = true;
                      caller = owner;
                      subjectSlippage = ether(0.0001);
                    });

                    function subject() {
                      return exchangeIssuance
                        .connect(caller.wallet)
                        .issueExactSetFromToken(
                          subjectSetToken,
                          subjectInputToken,
                          subjectSetAmount,
                          subjectMaxAmountInputToken,
                          subjectComponentQuotes,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                          { gasLimit: 750000000 },
                        );
                    }
                    [true, false].forEach(hasMatured => {
                      describe(`when component has ${!hasMatured ? "not " : ""}matured`, () => {
                        beforeEach(async () => {
                          if (hasMatured) {
                            await network.provider.send("evm_setNextBlockTimestamp", [
                              maturity.toNumber() + 1,
                            ]);
                            await network.provider.send("evm_mine", []);
                            await notionalTradeModule.redeemMaturedPositions(setToken.address);
                          }
                        });

                        ["underlyingToken", "usdc"].forEach((tokenType: string) => {
                          describe(`When issuing from ${tokenType}`, () => {
                            let inputToken: IERC20;
                            beforeEach(async () => {
                              if (tokenType == "underlyingToken") {
                                inputToken = underlyingToken;
                              } else {
                                inputToken = tokens[tokenType];
                                await inputToken.transfer(
                                  owner.address,
                                  (
                                    await inputToken.balanceOf(await inputToken.signer.getAddress())
                                  ).div(10),
                                );
                                inputToken = inputToken.connect(owner.wallet);
                              }

                              await inputToken.approve(
                                exchangeIssuance.address,
                                ethers.constants.MaxUint256,
                              );
                              subjectInputToken = inputToken.address;
                              subjectMaxAmountInputToken = await inputToken.balanceOf(
                                caller.address,
                              );
                              expect(subjectMaxAmountInputToken).to.be.gt(0);

                              const [
                                filteredComponents,
                              ] = await exchangeIssuance.getFilteredComponentsIssuance(
                                subjectSetToken,
                                subjectSetAmount,
                                subjectIssuanceModule,
                                subjectIsDebtIssuance,
                                subjectSlippage,
                              );
                              subjectComponentQuotes = filteredComponents.map(
                                (component: Address) => {
                                  return {
                                    path: [inputToken.address, component],
                                    fees: [3000],
                                    pool: ADDRESS_ZERO,
                                    exchange: Exchange.UniV3,
                                  };
                                },
                              );
                            });

                            it("should issue correct amount of set token", async () => {
                              const balanceBefore = await setToken.balanceOf(caller.address);
                              await subject();
                              const issuedAmount = (await setToken.balanceOf(caller.address)).sub(
                                balanceBefore,
                              );
                              expect(issuedAmount).to.eq(subjectSetAmount);
                            });

                            it("should spend correct amount of input token", async () => {
                              const balanceBefore = await inputToken.balanceOf(caller.address);
                              await subject();
                              const spentAmount = balanceBefore.sub(
                                await inputToken.balanceOf(caller.address),
                              );
                              expect(spentAmount).to.be.lte(subjectMaxAmountInputToken);
                            });
                          });
                        });
                      });
                    });
                  });
                  describe("#redeemExactSetForETH", () => {
                    let subjectSetToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectMinAmountETH: BigNumber;
                    let subjectComponentQuotes: SwapData[];
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let setAmountEth: number;
                    let caller: Account;

                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      setAmountEth = 1;
                      subjectSetAmount = ethers.utils.parseEther(setAmountEth.toString());
                      subjectIssuanceModule = debtIssuanceModule.address;
                      subjectIsDebtIssuance = true;
                      subjectMinAmountETH = BigNumber.from(1000);
                      subjectSlippage = ether(0.0001);
                      caller = owner;
                    });

                    function subject() {
                      return exchangeIssuance
                        .connect(caller.wallet)
                        .redeemExactSetForETH(
                          subjectSetToken,
                          subjectSetAmount,
                          subjectMinAmountETH,
                          subjectComponentQuotes,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                          { gasLimit: 750000000 },
                        );
                    }
                    describe("When caller has enough set token to redeem", () => {
                      beforeEach(async () => {
                        await underlyingToken
                          .connect(caller.wallet)
                          .approve(exchangeIssuance.address, ethers.constants.MaxUint256);

                        const [
                          filteredComponents,
                        ] = await exchangeIssuance.getFilteredComponentsIssuance(
                          subjectSetToken,
                          subjectSetAmount,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                        );
                        const swapData = filteredComponents.map(() => emptySwapData);
                        await exchangeIssuance
                          .connect(caller.wallet)
                          .issueExactSetFromToken(
                            setToken.address,
                            underlyingToken.address,
                            subjectSetAmount,
                            await underlyingToken.balanceOf(caller.address),
                            swapData,
                            debtIssuanceModule.address,
                            true,
                            subjectSlippage,
                            { gasLimit: 750000000 },
                          );
                        await setToken.approve(
                          exchangeIssuance.address,
                          ethers.constants.MaxUint256,
                        );
                      });
                      [true, false].forEach(hasMatured => {
                        describe(`when component has ${!hasMatured ? "not " : ""}matured`, () => {
                          beforeEach(async () => {
                            if (hasMatured) {
                              await network.provider.send("evm_setNextBlockTimestamp", [
                                maturity.toNumber() + 1,
                              ]);
                              await network.provider.send("evm_mine", []);
                              // TODO: Remove this statement and fix related issues
                              await notionalTradeModule.redeemMaturedPositions(setToken.address);
                            }

                            const [
                              filteredComponents,
                            ] = await exchangeIssuance.getFilteredComponentsRedemption(
                              subjectSetToken,
                              subjectSetAmount,
                              subjectIssuanceModule,
                              subjectIsDebtIssuance,
                              subjectSlippage,
                            );

                            subjectComponentQuotes = filteredComponents.map(
                              (component: Address) => {
                                return {
                                  path: [component, tokens.weth.address],
                                  fees: [3000],
                                  pool: ADDRESS_ZERO,
                                  exchange: Exchange.UniV3,
                                };
                              },
                            );
                            subjectMinAmountETH = BigNumber.from(1000);
                          });

                          it("should redeem correct amount of set token", async () => {
                            const balanceBefore = await setToken.balanceOf(caller.address);
                            await subject();
                            const redeemedAmount = balanceBefore.sub(
                              await setToken.balanceOf(caller.address),
                            );
                            expect(redeemedAmount).to.eq(subjectSetAmount);
                          });

                          it("should return correct amount of ETH", async () => {
                            const balanceBefore = await caller.wallet.getBalance();
                            const txFee = await getTxFee(await subject());
                            const balanceAfter = await caller.wallet.getBalance();
                            const returnedAmount = balanceAfter.sub(balanceBefore).add(txFee);
                            expect(returnedAmount).to.gte(subjectMinAmountETH);
                          });
                        });
                      });
                    });
                  });
                  describe("#redeemExactSetForToken", () => {
                    let subjectSetToken: Address;
                    let subjectOutputToken: Address;
                    let subjectSetAmount: BigNumber;
                    let subjectMinAmountOutputToken: BigNumber;
                    let subjectComponentQuotes: SwapData[];
                    let subjectIssuanceModule: Address;
                    let subjectIsDebtIssuance: boolean;
                    let subjectSlippage: BigNumber;
                    let setAmountEth: number;
                    let caller: Account;
                    beforeEach(async () => {
                      subjectSetToken = setToken.address;
                      setAmountEth = 1;
                      subjectSetAmount = ethers.utils.parseEther(setAmountEth.toString());
                      subjectIssuanceModule = debtIssuanceModule.address;
                      subjectIsDebtIssuance = true;
                      subjectMinAmountOutputToken = BigNumber.from(0);
                      subjectSlippage = ether(0.0001);
                      caller = owner;
                    });
                    function subject() {
                      return exchangeIssuance
                        .connect(caller.wallet)
                        .redeemExactSetForToken(
                          subjectSetToken,
                          subjectOutputToken,
                          subjectSetAmount,
                          subjectMinAmountOutputToken,
                          subjectComponentQuotes,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                          { gasLimit: 750000000 },
                        );
                    }
                    describe("When caller has enough set token to redeem", () => {
                      beforeEach(async () => {
                        await underlyingToken
                          .connect(caller.wallet)
                          .approve(exchangeIssuance.address, ethers.constants.MaxUint256);

                        const [
                          filteredComponents,
                        ] = await exchangeIssuance.getFilteredComponentsIssuance(
                          subjectSetToken,
                          subjectSetAmount,
                          subjectIssuanceModule,
                          subjectIsDebtIssuance,
                          subjectSlippage,
                        );
                        const swapData = filteredComponents.map(() => emptySwapData);
                        await exchangeIssuance
                          .connect(caller.wallet)
                          .issueExactSetFromToken(
                            setToken.address,
                            underlyingToken.address,
                            subjectSetAmount,
                            await underlyingToken.balanceOf(caller.address),
                            swapData,
                            debtIssuanceModule.address,
                            true,
                            subjectSlippage,
                            { gasLimit: 750000000 },
                          );
                        await setToken.approve(
                          exchangeIssuance.address,
                          ethers.constants.MaxUint256,
                        );
                      });
                      [true, false].forEach(hasMatured => {
                        describe(`when component has ${!hasMatured ? "not " : ""}matured`, () => {
                          beforeEach(async () => {
                            if (hasMatured) {
                              await network.provider.send("evm_setNextBlockTimestamp", [
                                maturity.toNumber() + 1,
                              ]);
                              await network.provider.send("evm_mine", []);
                            }
                          });

                          ["underlyingToken", "usdc"].forEach(tokenType => {
                            describe(`When redeeming to ${tokenType}`, () => {
                              let redeemAmountReturned: BigNumber;
                              let outputToken: IERC20;
                              beforeEach(async () => {
                                if (tokenType == "underlyingToken") {
                                  outputToken = underlyingToken;
                                } else {
                                  outputToken = tokens[tokenType];
                                  await outputToken.transfer(
                                    owner.address,
                                    (
                                      await outputToken.balanceOf(
                                        await outputToken.signer.getAddress(),
                                      )
                                    ).div(10),
                                  );
                                  outputToken = outputToken.connect(owner.wallet);
                                }
                                subjectOutputToken = outputToken.address;

                                const notionalProxy = (await ethers.getContractAt(
                                  "INotionalProxy",
                                  STAGING_ADDRESSES.lending.notional.notionalV2,
                                )) as INotionalProxy;
                                await notionalProxy.settleAccount(wrappedfCashInstance.address);
                                redeemAmountReturned = await wrappedfCashInstance.previewRedeem(
                                  wrappedfCashPosition.mul(setAmountEth),
                                );
                                await notionalTradeModule.redeemMaturedPositions(setToken.address);
                                const [
                                  filteredComponents,
                                ] = await exchangeIssuance.getFilteredComponentsRedemption(
                                  subjectSetToken,
                                  subjectSetAmount,
                                  subjectIssuanceModule,
                                  subjectIsDebtIssuance,
                                  subjectSlippage,
                                );
                                subjectMinAmountOutputToken =
                                  tokenType == "underlyingToken"
                                    ? redeemAmountReturned
                                    : BigNumber.from(1000);

                                subjectComponentQuotes = filteredComponents.map(
                                  (component: Address) => {
                                    return {
                                      path: [component, outputToken.address],
                                      fees: [3000],
                                      pool: ADDRESS_ZERO,
                                      exchange: Exchange.UniV3,
                                    };
                                  },
                                );
                              });
                              it("should redeem correct amount of set token", async () => {
                                const balanceBefore = await setToken.balanceOf(caller.address);
                                await subject();
                                const redeemedAmount = balanceBefore.sub(
                                  await setToken.balanceOf(caller.address),
                                );
                                expect(redeemedAmount).to.eq(subjectSetAmount);
                              });
                              it("should return correct amount of output token", async () => {
                                const balanceBefore = await outputToken.balanceOf(caller.address);
                                await subject();
                                const balanceAfter = await outputToken.balanceOf(caller.address);
                                const returnedAmount = balanceAfter.sub(balanceBefore);
                                expect(returnedAmount).to.gte(subjectMinAmountOutputToken);
                              });
                            });
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      }
    });
  });
}
